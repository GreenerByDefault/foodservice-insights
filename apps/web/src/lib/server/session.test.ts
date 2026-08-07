import type { UserId } from '@gbd/db';
import { insertAppUser, insertOrganization, withRollback } from '@gbd/db/testing';
import { afterAll, describe, expect, test } from 'vitest';
import { closeDatabase, database } from './db.ts';
import { loadSession, requireSession } from './session.ts';

afterAll(async () => {
  await closeDatabase();
});

describe('loadSession', () => {
  test('returns the organization the user belongs to, and their role in it', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);

      expect(await loadSession(transaction, admin.id)).toEqual({
        userId: admin.id,
        organization: { id: organization.id, name: organization.name, role: 'admin' },
      });
    });
  });

  test('returns null for a user who belongs to no organization', async () => {
    await withRollback(database(), async (transaction) => {
      const stranger = await insertAppUser(transaction);

      expect(await loadSession(transaction, stranger.id)).toBeNull();
    });
  });

  test('returns null for a user who does not exist', async () => {
    await withRollback(database(), async (transaction) => {
      expect(await loadSession(transaction, crypto.randomUUID() as UserId)).toBeNull();
    });
  });

  test('does not see another user’s membership', async () => {
    await withRollback(database(), async (transaction) => {
      await insertOrganization(transaction);
      const stranger = await insertAppUser(transaction);

      expect(await loadSession(transaction, stranger.id)).toBeNull();
    });
  });
});

describe('requireSession', () => {
  test('returns the session when there is one', () => {
    const session = {
      userId: crypto.randomUUID() as UserId,
      organization: { id: crypto.randomUUID(), name: 'Somewhere', role: 'member' },
    } as App.Locals['session'];

    expect(requireSession({ session })).toBe(session);
  });

  test('throws a 401 when there is not', () => {
    expect(() => requireSession({ session: null })).toThrowError(
      expect.objectContaining({ status: 401 }),
    );
  });
});
