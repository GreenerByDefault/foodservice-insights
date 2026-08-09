import { insertReport, withRollback } from '@gbd/db/testing';
import { isHttpError } from '@sveltejs/kit';
import { afterAll, expect, test, vi } from 'vitest';
import { closeDatabase, database, withDbErrorHandling } from './db.ts';

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

test('withDbErrorHandling logs context and 500s by default on failure', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const cause = new Error('connection refused');

  try {
    await expect(
      withDbErrorHandling(() => Promise.reject(cause), {
        action: 'load a widget',
        context: { widgetId: 'abc' },
      }),
    ).rejects.toMatchObject({ status: 500 });

    expect(logged).toHaveBeenCalledWith('Unexpected failure to load a widget', {
      widgetId: 'abc',
      error: cause,
    });
  } finally {
    logged.mockRestore();
  }
});

test('withDbErrorHandling supports an overridden status and body', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    const thrown = await withDbErrorHandling(() => Promise.reject(new Error('down')), {
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
