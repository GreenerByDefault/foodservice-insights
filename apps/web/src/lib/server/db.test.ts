import { isDatabaseError } from '@gbd/db';
import { insertReport, withRollback } from '@gbd/db/testing';
import { isHttpError } from '@sveltejs/kit';
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

test('withDbErrorHandling logs context and 500s by default on a database failure', async () => {
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
    expect(isDatabaseError(meta.error)).toBe(true);
  } finally {
    logged.mockRestore();
  }
});

test('withDbErrorHandling supports an overridden status and body', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    const thrown = await withDbErrorHandling(divideByZero, {
      action: 'load authorization',
      status: 503,
      body: { message: 'The service is temporarily unavailable', code: 'service_unavailable' },
    }).catch((error: unknown) => error);

    if (!isHttpError(thrown)) throw thrown;
    expect(thrown.status).toBe(503);
    expect(thrown.body).toEqual({
      message: 'The service is temporarily unavailable',
      code: 'service_unavailable',
    });
  } finally {
    logged.mockRestore();
  }
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
