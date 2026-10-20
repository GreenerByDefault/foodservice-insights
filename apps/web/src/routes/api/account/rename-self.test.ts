import { insertAppUser, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '#lib/server/db.js';
import { _renameSelf } from './+server.ts';

describe('_renameSelf', () => {
  test('a valid name answers 204 and stores it trimmed', async () => {
    await withRollback(database(), async (transaction) => {
      const user = await insertAppUser(transaction, { displayName: 'Sam Cook' });

      const response = await _renameSelf(transaction, user.id, { displayName: '  Alex Baker  ' });

      expect(response.status).toBe(204);
      const renamed = await transaction
        .selectFrom('appUser')
        .select('displayName')
        .where('id', '=', user.id)
        .executeTakeFirstOrThrow();
      expect(renamed.displayName).toBe('Alex Baker');
    });
  });

  test('renames only the given user', async () => {
    await withRollback(database(), async (transaction) => {
      const user = await insertAppUser(transaction, { displayName: 'Sam Cook' });
      const bystander = await insertAppUser(transaction, { displayName: 'Sam Cook' });

      await _renameSelf(transaction, user.id, { displayName: 'Alex Baker' });

      const untouched = await transaction
        .selectFrom('appUser')
        .select('displayName')
        .where('id', '=', bystander.id)
        .executeTakeFirstOrThrow();
      expect(untouched.displayName).toBe('Sam Cook');
    });
  });

  describe('the browser’s time zone', () => {
    async function renameAndReadCountry(body: object, country?: string): Promise<string | null> {
      return await withRollback(database(), async (transaction) => {
        const user = await insertAppUser(transaction, {
          displayName: 'Sam Cook',
          ...(country !== undefined && { country }),
        });

        const response = await _renameSelf(transaction, user.id, {
          displayName: 'Alex Baker',
          ...body,
        });

        expect(response.status).toBe(204);
        const row = await transaction
          .selectFrom('appUser')
          .select('country')
          .where('id', '=', user.id)
          .executeTakeFirstOrThrow();
        return row.country;
      });
    }

    test('stores its country', async () => {
      expect(await renameAndReadCountry({ timeZone: 'Europe/Amsterdam' }, 'US')).toBe('NL');
    });

    test('one that maps to no country stores null', async () => {
      expect(await renameAndReadCountry({ timeZone: 'Made/Up' }, 'US')).toBeNull();
    });

    test('left out, leaves the country as it was', async () => {
      expect(await renameAndReadCountry({}, 'US')).toBe('US');
    });

    test('of the wrong type answers 400', async () => {
      await withRollback(database(), async (transaction) => {
        const user = await insertAppUser(transaction, { displayName: 'Sam Cook' });

        const response = await _renameSelf(transaction, user.id, {
          displayName: 'Alex Baker',
          timeZone: 42,
        });

        expect(response.status).toBe(400);
      });
    });
  });

  test.for([
    ['null', { displayName: null }],
    ['empty', { displayName: '' }],
    ['blank', { displayName: '   ' }],
    ['one-character', { displayName: 'x' }],
    ['over 100 chars', { displayName: 'x'.repeat(101) }],
    ['missing', {}],
  ] as const)('answers 400 for a %s displayName', async ([, body]) => {
    await withRollback(database(), async (transaction) => {
      const user = await insertAppUser(transaction, { displayName: 'Sam Cook' });

      const response = await _renameSelf(transaction, user.id, body);

      expect(response.status).toBe(400);
    });
  });
});
