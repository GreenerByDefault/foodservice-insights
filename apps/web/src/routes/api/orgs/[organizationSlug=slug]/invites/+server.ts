import { HOUR_MS, INVITE_LIFETIME_DAYS } from '@gbd/core';
import {
  countInvitesSince,
  type DatabaseExecutor,
  lockInviteRateLimit,
  type OrganizationId,
  withTransaction,
} from '@gbd/db';
import { json } from '@sveltejs/kit';
import { sql } from 'kysely';
import * as v from 'valibot';
import { emailAddress } from '$lib/forms/validation';
import { HOURLY_INVITE_LIMIT } from '$lib/invites/limits';
import { recordAuditEvent } from '$lib/server/audit';
import { requireAuth } from '$lib/server/auth/guards';
import { requireOrganizationRouteContext } from '$lib/server/auth/route-context';
import type { Actor } from '$lib/server/auth/types';
import { parseBody } from '$lib/server/body';
import { database, withDbErrorHandling } from '$lib/server/db';
import { sendInvite } from '$lib/server/email';
import type { RequestHandler } from './$types';

const CreateInviteBodySchema = v.object({
  email: emailAddress,
  role: v.picklist(['admin', 'member']),
});

/** Invite an address, or re-invite one that is already outstanding — which supersedes the pending
 * row and restarts its lifetime, because `organization_invite_one_pending_per_email` permits only
 * one. The email links to `/sign-in?email=...` and carries no token. Admin only, capped at
 * `HOURLY_INVITE_LIMIT` per hour for the inviting user.
 */
export const POST: RequestHandler = async (event) => {
  const { organizationId, organizationName, actor } = await requireOrganizationRouteContext(
    database(),
    event,
    { admin: true },
  );
  const actorDisplayName = requireAuth(event.locals).user.displayName;
  const body = await event.request.json();

  return await _createInvite(database(), {
    organizationId,
    organizationName,
    actor,
    actorDisplayName,
    body,
  });
};

type CreateInviteOutcome =
  | { kind: 'created'; inviteId: string; expiresAt: Date }
  | { kind: 'rate-limited' }
  | { kind: 'already-member' };

/** Create (or resupersede) a pending invite for `body`'s `{ email, role }`.
 *
 * - 400 for a body that isn't `{ email: string, role: 'admin' | 'member' }`.
 * - 429 `rate-limited` if `actor` has sent `HOURLY_INVITE_LIMIT` invites in the past hour.
 * - 409 `already-member` if `email` already belongs to `organizationId`.
 * - Otherwise supersedes any pending invite for the address, inserts a new one, records
 *   `invite.created`, and — after the transaction commits — sends the invite email. 201
 *   `{ inviteId, emailSent }`.
 */
export async function _createInvite(
  db: DatabaseExecutor,
  params: {
    organizationId: OrganizationId;
    organizationName: string;
    actor: Actor;
    actorDisplayName: string | null;
    body: unknown;
  },
): Promise<Response> {
  const { organizationId, organizationName, actor, actorDisplayName } = params;

  const parsedBody = parseBody(CreateInviteBodySchema, params.body);
  if (!parsedBody.ok) return parsedBody.response;
  const { email, role } = parsedBody.value;

  const outcome = await withDbErrorHandling(
    () =>
      withTransaction(db, async (transaction): Promise<CreateInviteOutcome> => {
        await lockInviteRateLimit(transaction, { userId: actor.userId });
        const count = await countInvitesSince(transaction, {
          userId: actor.userId,
          windowSeconds: HOUR_MS / 1000,
        });
        if (count >= HOURLY_INVITE_LIMIT) return { kind: 'rate-limited' };

        // `auth.users.email` isn't guaranteed lowercase by any constraint — only `organization_
        // invite.email` is — so this compares with `lower()` rather than trusting the column,
        // even though GoTrue happens to lowercase it today.
        const existingMember = await transaction
          .selectFrom('organizationMember')
          .innerJoin('appUser', 'appUser.id', 'organizationMember.userId')
          .innerJoin('auth.users', 'auth.users.id', 'appUser.id')
          .select('appUser.id')
          .where('organizationMember.organizationId', '=', organizationId)
          .where((eb) => eb(sql<string>`lower(auth.users.email)`, '=', email))
          .executeTakeFirst();
        if (existingMember) return { kind: 'already-member' };

        await transaction
          .updateTable('organizationInvite')
          .set({ status: 'superseded' })
          .where('organizationId', '=', organizationId)
          .where('email', '=', email)
          .where('status', '=', 'pending')
          .execute();

        const invite = await transaction
          .insertInto('organizationInvite')
          .values({
            organizationId,
            email,
            role,
            status: 'pending',
            invitedByUserId: actor.userId,
            expiresAt: sql<Date>`now() + make_interval(days => ${INVITE_LIFETIME_DAYS})`,
          })
          .returning(['id', 'expiresAt'])
          .executeTakeFirstOrThrow();

        await recordAuditEvent(transaction, {
          action: 'invite.created',
          actor,
          target: { type: 'invite', id: invite.id, organizationId },
        });

        return { kind: 'created', inviteId: invite.id, expiresAt: invite.expiresAt };
      }),
    { action: 'create an invite', context: { organizationId } },
  );

  if (outcome.kind === 'rate-limited') {
    return json(
      { message: "You've sent too many invites. Try again in an hour.", code: 'rate-limited' },
      { status: 429 },
    );
  }
  if (outcome.kind === 'already-member') {
    return json(
      { message: 'That person is already a member.', code: 'already-member' },
      { status: 409 },
    );
  }

  const emailSent = await sendInvite({
    kind: 'organization-invite',
    to: email,
    organizationName,
    role,
    invitedByName: actorDisplayName,
    expiresAt: outcome.expiresAt,
  });

  return json({ inviteId: outcome.inviteId, emailSent }, { status: 201 });
}
