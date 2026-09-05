/** Every URL of ours that takes an id, built in one place so the same route isn't spelled out
 * independently by the loader that hands it out and the component that follows it. A URL with no
 * id in it — `/account`, `/orgs/new` — stays a literal where it is used; there is nothing to get
 * wrong and nothing to keep in step.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

// -----------------------------------------------------
// Organization pages
// -----------------------------------------------------

/** An organization's report list — its home, since reports live at the organization's root. Also
 * where an upload lands the user if the server's `created` response carries no `location` header,
 * and the "unsure whether that went through" fallback. */
export function organizationHref(organizationId: string): string {
  return `/orgs/${organizationId}`;
}

export function organizationMembersHref(organizationId: string): string {
  return `${organizationHref(organizationId)}/members`;
}

export function organizationSettingsHref(organizationId: string): string {
  return `${organizationHref(organizationId)}/settings`;
}

// -----------------------------------------------------
// Report pages
// -----------------------------------------------------

export function newReportHref(organizationId: string): string {
  return `${organizationHref(organizationId)}/reports/new`;
}

export function reportHref(organizationId: string, reportId: string): string {
  return `${organizationHref(organizationId)}/reports/${reportId}`;
}

/** The reports list, paged to the reports older than `reportId` — the last report on the page
 * being left. See `pagination.ts`. */
export function olderReportsHref(organizationId: string, reportId: string): string {
  return `${organizationHref(organizationId)}?older=${reportId}`;
}

/** The reports list, paged to the reports newer than `reportId` — the first report on the page
 * being left. See `pagination.ts`. */
export function newerReportsHref(organizationId: string, reportId: string): string {
  return `${organizationHref(organizationId)}?newer=${reportId}`;
}

// -----------------------------------------------------
// Poll endpoints
// -----------------------------------------------------
// Each sits beside the page it refreshes rather than under `/api`, which holds only writes — see
// `README.md` § Routes.

export function reportsPollHref(organizationId: string): string {
  return `${organizationHref(organizationId)}/poll`;
}

export function reportPollHref(organizationId: string, reportId: string): string {
  return `${reportHref(organizationId, reportId)}/poll`;
}

// -----------------------------------------------------
// File downloads
// -----------------------------------------------------

export function inputFileHref(inputFileId: string): string {
  return `/file/input/${inputFileId}`;
}

export function resultFileHref(resultFileId: string): string {
  return `/file/result/${resultFileId}`;
}

// -----------------------------------------------------
// API writes
// -----------------------------------------------------

/** The organization itself, which the rename form `PATCH`es and the delete button `DELETE`s.
 * `/api/orgs` carries no id, so creating one stays a literal where it is used. */
export function organizationApiHref(organizationId: string): string {
  return `/api/orgs/${organizationId}`;
}

/** Where the new-report form POSTs an upload. */
export function createReportApiHref(organizationId: string): string {
  return `${organizationApiHref(organizationId)}/reports`;
}

/** The report itself, which the delete button sends `DELETE` to. */
export function reportApiHref(organizationId: string, reportId: string): string {
  return `${createReportApiHref(organizationId)}/${reportId}`;
}

export function cancelReportApiHref(organizationId: string, reportId: string): string {
  return `${reportApiHref(organizationId, reportId)}/cancel`;
}

export function retryReportApiHref(organizationId: string, reportId: string): string {
  return `${reportApiHref(organizationId, reportId)}/retry`;
}
