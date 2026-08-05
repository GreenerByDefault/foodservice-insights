/** `audit_event`: append-only, and deliberately unconstrained by foreign keys.
 *
 * Both properties exist for the same reason. Users and organizations can be hard-deleted, but
 * their IDs have to survive here — a foreign key would either block the delete or erase the
 * evidence, and an UPDATE or DELETE would let someone edit the record of what they did.
 */

import { afterAll, describe, expect, test } from 'vitest';
import { DATABASE } from '../src/env.ts';
import { POSTGRES_CODE_CHECK_VIOLATION } from '../src/postgres-codes.ts';
import { insertAppUser, insertOrganization } from '../src/testing/fixtures.ts';
import { withRollback } from '../src/testing/transactions.ts';

afterAll(async () => {
  await DATABASE.destroy();
});

function anEvent(overrides: Record<string, unknown> = {}) {
  return {
    action: 'report.deleted',
    actorKind: 'user' as const,
    actorUserId: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    targetType: 'report',
    targetId: crypto.randomUUID(),
    ...overrides,
  };
}

describe('audit_event', () => {
  test('records actors and organizations that do not exist', async () => {
    // Not a loophole — the point. The trail has to outlive the rows it names.
    const stored = await withRollback(DATABASE, async (transaction) => {
      return await transaction
        .insertInto('auditEvent')
        .values(anEvent())
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    expect(stored).toMatchObject({ action: 'report.deleted', actorKind: 'user' });
    expect(stored.occurredAt).toBeInstanceOf(Date);
  });

  test('outlives the user and organization it names', async () => {
    const stored = await withRollback(DATABASE, async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const actor = await insertAppUser(transaction);

      const event = await transaction
        .insertInto('auditEvent')
        .values(anEvent({ actorUserId: actor.id, organizationId: organization.id }))
        .returningAll()
        .executeTakeFirstOrThrow();

      await transaction.deleteFrom('organization').where('id', '=', organization.id).execute();
      await transaction.deleteFrom('auth.users').where('id', '=', actor.id).execute();

      return await transaction
        .selectFrom('auditEvent')
        .selectAll()
        .where('id', '=', event.id)
        .executeTakeFirstOrThrow();
    });

    expect(stored.actorUserId).not.toBeNull();
    expect(stored.organizationId).not.toBeNull();
  });

  test('rejects an update', async () => {
    const update = withRollback(DATABASE, async (transaction) => {
      const event = await transaction
        .insertInto('auditEvent')
        .values(anEvent())
        .returning('id')
        .executeTakeFirstOrThrow();

      await transaction
        .updateTable('auditEvent')
        .set({ action: 'report.created' })
        .where('id', '=', event.id)
        .execute();
    });

    await expect(update).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'audit_event_is_append_only',
    });
  });

  test('rejects a delete', async () => {
    const remove = withRollback(DATABASE, async (transaction) => {
      const event = await transaction
        .insertInto('auditEvent')
        .values(anEvent())
        .returning('id')
        .executeTakeFirstOrThrow();

      await transaction.deleteFrom('auditEvent').where('id', '=', event.id).execute();
    });

    await expect(remove).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'audit_event_is_append_only',
    });
  });
});
