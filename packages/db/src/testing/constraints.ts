import { expect } from 'vitest';
import { POSTGRES_CODE_CHECK_VIOLATION } from '../postgres-codes.ts';

/** Asserts that `work` rejects with the given Postgres constraint violation.
 *
 * `toMatchObject` is deliberate here — the one case
 * [`AGENTS.md`](../../../../AGENTS.md)'s testing philosophy allows for. A `pg.DatabaseError`
 * carries a dozen fields (message, severity, position, schema, table, detail, ...) no test
 * cares about, and asserting the full object would break on a Postgres or driver detail that
 * has nothing to do with the constraint under test.
 */
export async function expectConstraintViolation(
  work: Promise<unknown>,
  constraint: string,
  code = POSTGRES_CODE_CHECK_VIOLATION,
): Promise<void> {
  await expect(work).rejects.toMatchObject({ code, constraint });
}
