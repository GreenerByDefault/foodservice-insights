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

  test.for([
    ['null', { displayName: null }],
    ['empty', { displayName: '' }],
    ['blank', { displayName: '   ' }],
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
