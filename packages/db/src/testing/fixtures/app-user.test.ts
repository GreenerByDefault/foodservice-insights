import { sql } from 'kysely';
import { describe, expect, test } from 'vitest';
import { DATABASE } from '../../env.ts';
import { withRollback } from '../transactions.ts';
import { findOrInsertAppUser, insertAppUser } from './app-user.ts';
import { dbMsAgo } from './values.ts';

describe('insertAppUser', () => {
  test('takes the id it is given, for a user mirrored from GoTrue', async () => {
    await withRollback(DATABASE, async (transaction) => {
      const id = crypto.randomUUID();

      const user = await insertAppUser(transaction, { id, displayName: 'Dana Cook' });

      expect(user).toMatchObject({ id, displayName: 'Dana Cook' });
    });
  });

  test('backdates createdAt and emailConfirmedAt on the auth.users row', async () => {
    const { row, now } = await withRollback(DATABASE, async (transaction) => {
      const user = await insertAppUser(transaction, {
        createdAt: dbMsAgo(60_000),
        emailConfirmedAt: dbMsAgo(30_000),
      });
      const row = await transaction
        .selectFrom('auth.users')
        .select(['createdAt', 'emailConfirmedAt'])
        .where('id', '=', user.id)
        .executeTakeFirstOrThrow();
      const { rows } = await sql<{ now: Date }>`SELECT now()`.execute(transaction);
      return { row, now: (rows[0] as { now: Date }).now };
    });

    expect(row).toEqual({
      createdAt: new Date(now.getTime() - 60_000),
      emailConfirmedAt: new Date(now.getTime() - 30_000),
    });
  });

  test('leaves createdAt and emailConfirmedAt null when not given', async () => {
    const row = await withRollback(DATABASE, async (transaction) => {
      const user = await insertAppUser(transaction);
      return await transaction
        .selectFrom('auth.users')
        .select(['createdAt', 'emailConfirmedAt'])
        .where('id', '=', user.id)
        .executeTakeFirstOrThrow();
    });

    expect(row).toEqual({ createdAt: null, emailConfirmedAt: null });
  });
});

describe('findOrInsertAppUser', () => {
  test('returns the existing user for an address already taken, with the display name re-applied', async () => {
    await withRollback(DATABASE, async (transaction) => {
      const email = `${crypto.randomUUID()}@example.test`;
      const first = await findOrInsertAppUser(transaction, { email, displayName: 'Dana Cook' });

      const second = await findOrInsertAppUser(transaction, { email, displayName: 'Dana Cook' });

      expect(second).toEqual(first);
    });
  });

  test('leaves the display name alone when none is given', async () => {
    await withRollback(DATABASE, async (transaction) => {
      const email = `${crypto.randomUUID()}@example.test`;
      await findOrInsertAppUser(transaction, { email, displayName: 'Dana Cook' });

      const found = await findOrInsertAppUser(transaction, { email });

      expect(found.displayName).toBe('Dana Cook');
    });
  });
});
