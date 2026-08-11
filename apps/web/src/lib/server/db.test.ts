import { isPermanentDatabaseError } from '@gbd/db';
import {
  aDatabaseError,
  anUnreachableDatabaseError,
  insertReport,
  withRollback,
} from '@gbd/db/testing';
import { error, isHttpError } from '@sveltejs/kit';
import { sql } from 'kysely';
import { afterAll, expect, test, vi } from 'vitest';
import { closeDatabase, database, withDbErrorHandling } from './db.ts';

/** A genuine Postgres failure, to exercise the path `withDbErrorHandling` converts. */
const divideByZero = () => sql`select 1 / 0`.execute(database());

afterAll(async () => {
  await closeDatabase();
});

test('queries the database through the app handle, rolling back after', async () => {
  const id = await withRollback(database(), async (transaction) => {
    const report = await insertReport(transaction, { name: 'From the web app' });

    expect(report).toMatchObject({ name: 'From the web app', countsBasis: 'people' });
    return report.id;
  });

  const afterRollback = await database()
    .selectFrom('report')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  expect(afterRollback).toBeUndefined();
});

test('withDbErrorHandling returns the value on success', async () => {
  await expect(
    withDbErrorHandling(() => Promise.resolve('ok'), { action: 'do a thing' }),
  ).resolves.toBe('ok');
});

test('withDbErrorHandling logs context and 500s a statement Postgres refused', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    const thrown = await withDbErrorHandling(divideByZero, {
      action: 'load a widget',
      context: { widgetId: 'abc' },
    }).catch((error: unknown) => error);

    if (!isHttpError(thrown)) throw thrown;
    expect(thrown.status).toBe(500);

    expect(logged).toHaveBeenCalledTimes(1);
    const [message, meta] = logged.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('Unexpected failure to load a widget');
    expect(meta).toMatchObject({ widgetId: 'abc' });
    expect(isPermanentDatabaseError(meta.error)).toBe(true);
  } finally {
    logged.mockRestore();
  }
});

/** That a real outage arrives in this shape is `@gbd/db`'s own test, against a closed port. This
 * only needs something that is one.
 */
const databaseIsDown = () => Promise.reject(anUnreachableDatabaseError());

test('withDbErrorHandling logs context and 503s an unreachable database', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    const thrown = await withDbErrorHandling(databaseIsDown, {
      action: 'load a widget',
      context: { widgetId: 'abc' },
    }).catch((error: unknown) => error);

    if (!isHttpError(thrown)) throw thrown;
    expect(thrown.status).toBe(503);
    expect(thrown.body.code).toBe('service_unavailable');

    expect(logged).toHaveBeenCalledTimes(1);
    const [message, meta] = logged.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('Could not reach the database to load a widget');
    expect(meta).toMatchObject({ widgetId: 'abc' });
  } finally {
    logged.mockRestore();
  }
});

test('withDbErrorHandling 503s a statement the database gave up on', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const canceled = () =>
    Promise.reject(aDatabaseError('canceling statement due to timeout', '57014'));

  try {
    const thrown = await withDbErrorHandling(canceled, { action: 'load a widget' }).catch(
      (error: unknown) => error,
    );

    if (!isHttpError(thrown)) throw thrown;
    expect(thrown.status).toBe(503);
  } finally {
    logged.mockRestore();
  }
});

// What the retry endpoint will rely on to answer 409 for a violation it expects.
test('withDbErrorHandling passes through the answer a caller gave itself', async () => {
  const conflict = async () => {
    try {
      await divideByZero();
    } catch {
      error(409, { message: 'That report already has an attempt running' });
    }
  };

  const thrown = await withDbErrorHandling(conflict, { action: 'enqueue a retry' }).catch(
    (cause: unknown) => cause,
  );

  if (!isHttpError(thrown)) throw thrown;
  expect(thrown.status).toBe(409);
});

test('withDbErrorHandling rethrows a failure that is not from the database', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const cause = new Error('a bug unrelated to Postgres');

  try {
    await expect(
      withDbErrorHandling(() => Promise.reject(cause), { action: 'do a thing' }),
    ).rejects.toBe(cause);
    expect(logged).not.toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});
