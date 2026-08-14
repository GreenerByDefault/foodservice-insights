/** Its job is to stop the rest of the suite passing vacuously: a `Breakable` whose `break()`
 * doesn't produce a genuine failure, or whose `restore()` doesn't produce a genuine recovery,
 * would make every parked-verdict and fencing test built on it pass for the wrong reason.
 */

import { sql } from 'kysely';
import { DatabaseError } from 'pg';
import { describe, expect, test } from 'vitest';
import { isPermanentDatabaseError, isTransientDatabaseError } from '../errors.ts';
import { breakableDatabase } from './breakable.ts';

describe('breakableDatabase', () => {
  test('a broken proxy fails transiently, and a restored one answers a query', async () => {
    const breakable = await breakableDatabase();
    try {
      breakable.break();
      const failure = await sql`select 1`.execute(breakable.service).catch((error) => error);

      expect(failure).not.toBeInstanceOf(DatabaseError);
      expect(isTransientDatabaseError(failure)).toBe(true);
      expect(isPermanentDatabaseError(failure)).toBe(false);

      breakable.restore();
      await expect(sql`select 1`.execute(breakable.service)).resolves.toBeDefined();
    } finally {
      await breakable.close();
    }
  });
});
