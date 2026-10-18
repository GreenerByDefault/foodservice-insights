import { describe, expect, test } from 'vitest';
import { DATABASE } from '../../env.ts';
import { withRollback } from '../transactions.ts';
import { findOrInsertAppUser, insertAppUser } from './app-user.ts';

describe('insertAppUser', () => {
  test('takes the id it is given, for a user mirrored from GoTrue', async () => {
    await withRollback(DATABASE, async (transaction) => {
      const id = crypto.randomUUID();

      const user = await insertAppUser(transaction, { id, displayName: 'Dana Cook' });

      expect(user).toMatchObject({ id, displayName: 'Dana Cook' });
    });
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
