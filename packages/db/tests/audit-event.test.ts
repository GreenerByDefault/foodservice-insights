import { sql } from 'kysely';
import { describe, expect, test } from 'vitest';
import { DATABASE } from '../src/env.ts';
import type { UsersId } from '../src/generated/auth/Users.ts';
import type { NewAuditEvent } from '../src/generated/public/AuditEvent.ts';
import type { OrganizationId } from '../src/generated/public/Organization.ts';
import { expectConstraintViolation } from '../src/testing/constraints.ts';
import { insertAppUser, insertOrganization } from '../src/testing/fixtures/index.ts';
import { withRollback } from '../src/testing/transactions.ts';

function anEvent(overrides: Partial<NewAuditEvent> = {}): NewAuditEvent {
  return {
    action: 'report.deleted',
    actorKind: 'user',
    actorUserId: crypto.randomUUID() as UsersId,
    organizationId: crypto.randomUUID() as OrganizationId,
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
    const { stored, actor, organization } = await withRollback(DATABASE, async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const actor = await insertAppUser(transaction);

      const event = await transaction
        .insertInto('auditEvent')
        .values(anEvent({ actorUserId: actor.id, organizationId: organization.id }))
        .returningAll()
        .executeTakeFirstOrThrow();

      await transaction.deleteFrom('organization').where('id', '=', organization.id).execute();
      await transaction.deleteFrom('auth.users').where('id', '=', actor.id).execute();

      const stored = await transaction
        .selectFrom('auditEvent')
        .selectAll()
        .where('id', '=', event.id)
        .executeTakeFirstOrThrow();

      return { stored, actor, organization };
    });

    expect(stored.actorUserId).toBe(actor.id);
    expect(stored.organizationId).toBe(organization.id);
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

    await expectConstraintViolation(update, 'audit_event_is_append_only');
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

    await expectConstraintViolation(remove, 'audit_event_is_append_only');
  });
});

describe('audit_event_actor_user_id', () => {
  test('indexes the actor, which no foreign key does here', async () => {
    const definition = await withRollback(DATABASE, async (transaction) => {
      const { rows } = await sql<{ definition: string | null }>`
        SELECT pg_get_indexdef(to_regclass('public.audit_event_actor_user_id')) AS definition
      `.execute(transaction);
      return rows[0]?.definition ?? 'no such index';
    });

    expect(definition).toMatch(/^CREATE INDEX .* \(actor_user_id\)$/);
  });
});
