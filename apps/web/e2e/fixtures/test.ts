/** The extended Playwright `test` for specs that need a report already in the database.
 *
 * Import `@gbd/db/env` only from here, never from `playwright.config.ts` — it opens a connection
 * pool at import time, and the config-loading process has no worker fixture to close it again.
 */

import type { Database, OrganizationId, OrganizationRole, ReportId } from '@gbd/db';
import { DATABASE, shutdown } from '@gbd/db/env';
import { test as base } from '@playwright/test';
import type { Kysely } from 'kysely';
import {
  clearOrganizationFixture,
  insertOrganizationFixture,
  type OrganizationInviteSpec,
  type OrganizationMemberSpec,
  type OrganizationReportSpec,
} from './organizations.ts';
import { insertReportFixture, type ReportState } from './reports.ts';

export interface ReportFactory {
  /** Commit a report in `state` and return its id. Deleted when this test ends, whether it
   * passed or failed — a behavioural spec is free to mutate what it created (cancel it, retry
   * it) without touching another test's rows. */
  create(state: ReportState): Promise<ReportId>;

  /** Register a report id this test created some other way — through the UI, or the API directly
   * — for the same end-of-test cleanup as `create`, instead of a spec hand-parsing a URL and
   * deleting the row itself. */
  adopt(id: ReportId): void;
}

export interface OrganizationFactory {
  /** Commit a private organization the placeholder user belongs to. Deleted when this test ends,
   * whether it passed or failed. Returns its id, and the ids of the reports it minted (in the
   * order given in `spec.reports`) — so a spec that needs to act on one of its own reports never
   * has to re-query for it.
   *
   * `role` defaults to `admin`, which also makes the placeholder its creator and sole member;
   * `member` puts a disposable admin above it instead. See `insertOrganizationFixture`. */
  create(spec: {
    name: string;
    reports?: OrganizationReportSpec[];
    role?: OrganizationRole;
    members?: OrganizationMemberSpec[];
    invites?: OrganizationInviteSpec[];
  }): Promise<{ id: OrganizationId; reportIds: ReportId[] }>;

  /** Register an organization id this test created some other way — through the UI — for the
   * same end-of-test cleanup as `create`, instead of a spec hand-parsing a URL and deleting the
   * row itself. */
  adopt(id: OrganizationId): void;
}

export const test = base.extend<
  {
    reports: ReportFactory;
    organizations: OrganizationFactory;
  },
  { db: Kysely<Database> }
>({
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
      adopt: (id) => {
        createdIds.push(id);
      },
    });

    if (createdIds.length > 0) {
      await db.deleteFrom('report').where('id', 'in', createdIds).execute();
    }
  },

  organizations: async ({ db }, use) => {
    const createdIds: OrganizationId[] = [];

    await use({
      create: async (spec) => {
        const { organizationId, reportIds } = await insertOrganizationFixture(db, spec);
        createdIds.push(organizationId);
        return { id: organizationId, reportIds };
      },
      adopt: (id) => {
        createdIds.push(id);
      },
    });

    await Promise.all(createdIds.map((id) => clearOrganizationFixture(db, id)));
  },
});
