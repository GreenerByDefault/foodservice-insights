/** `@gbd/browser-testing/fixtures`' `test`, plus what only this suite needs: a report already in
 * the database, and an organization built to a spec.
 */

import { test as base } from '@gbd/browser-testing/fixtures';
import type { OrganizationId, OrganizationRole, ReportId } from '@gbd/db';
import {
  clearOrganizationFixture,
  insertOrganizationFixture,
  type OrganizationInviteSpec,
  type OrganizationMemberSpec,
  type OrganizationReportSpec,
} from './organizations.ts';
import { insertReportFixture, type ReportState } from './reports.ts';

export interface ReportFactory {
  /** Commit a report in `state` in this test's own `org`, and return its id. Goes when `org`
   * does, so a behavioural spec is free to mutate what it created (cancel it, retry it) without
   * touching another test's rows. */
  create(state: ReportState): Promise<ReportId>;
}

export interface OrganizationFactory {
  /** Commit a second organization the signed-in user belongs to, beyond the `org` every test
   * already has. Deleted when this test ends, whether it passed or failed. Returns its id, and
   * the ids of the reports it minted (in the order given in `spec.reports`) — so a spec that
   * needs to act on one of its own reports never has to re-query for it.
   *
   * `role` defaults to `admin`, which also makes the user its creator and sole member; `member`
   * puts a disposable admin above it instead. See `insertOrganizationFixture`. */
  create(spec: {
    name: string;
    reports?: OrganizationReportSpec[];
    role?: OrganizationRole;
    members?: OrganizationMemberSpec[];
    invites?: OrganizationInviteSpec[];
  }): Promise<{ id: OrganizationId; slug: string; reportIds: ReportId[] }>;

  /** Register an organization id this test created some other way — through the UI — for the
   * same end-of-test cleanup as `create`, instead of a spec hand-parsing a URL and deleting the
   * row itself. */
  adopt(id: OrganizationId): void;
}

export const test = base.extend<{
  reports: ReportFactory;
  organizations: OrganizationFactory;
}>({
  reports: async ({ db, org }, use) => {
    await use({
      create: async (state) => await insertReportFixture(db, state, org.id),
    });
  },

  organizations: async ({ db, user }, use) => {
    const createdIds: OrganizationId[] = [];

    await use({
      create: async (spec) => {
        const { organizationId, organizationSlug, reportIds } = await insertOrganizationFixture(
          db,
          user.id,
          spec,
        );
        createdIds.push(organizationId);
        return { id: organizationId, slug: organizationSlug, reportIds };
      },
      adopt: (id) => {
        createdIds.push(id);
      },
    });

    await Promise.all(createdIds.map((id) => clearOrganizationFixture(db, id)));
  },
});
