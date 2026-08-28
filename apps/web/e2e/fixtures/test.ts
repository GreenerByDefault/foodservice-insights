/** The extended Playwright `test` for specs that need a report already in the database.
 *
 * Import `@gbd/db/env` only from here, never from `playwright.config.ts` — it opens a connection
 * pool at import time, and the config-loading process has no worker fixture to close it again.
 */

import type { Database, ReportId } from '@gbd/db';
import { DATABASE, shutdown } from '@gbd/db/env';
import { test as base } from '@playwright/test';
import type { Kysely } from 'kysely';
import { insertReportFixture, type ReportState } from './reports.ts';

export interface ReportFactory {
  /** Commit a report in `state` and return its id. Deleted when this test ends, whether it
   * passed or failed — a behavioural spec is free to mutate what it created (cancel it, retry
   * it) without touching another test's rows. */
  create(state: ReportState): Promise<ReportId>;
}

export const test = base.extend<{ reports: ReportFactory }, { db: Kysely<Database> }>({
  // Worker-scoped: one pool per Playwright worker process, closed or the worker hangs.
  db: [
    // The empty pattern is required, not vestigial: Playwright statically parses a fixture
    // function's first parameter to learn its dependencies, and rejects anything but an object
    // (destructured or not).
    // biome-ignore lint/correctness/noEmptyPattern: required by Playwright's fixture signature.
    async ({}, use) => {
      await use(DATABASE);
      await shutdown();
    },
    { scope: 'worker' },
  ],

  reports: async ({ db }, use) => {
    const createdIds: ReportId[] = [];

    await use({
      create: async (state) => {
        const reportId = await insertReportFixture(db, state);
        createdIds.push(reportId);
        return reportId;
      },
    });

    if (createdIds.length > 0) {
      await db.deleteFrom('report').where('id', 'in', createdIds).execute();
    }
  },
});
