/** Every URL of ours that takes an id, built in one place so the same route isn't spelled out
 * independently by the loader that hands it out and the component that follows it. A URL with no
 * id in it — `/account`, `/orgs/new` — stays a literal where it is used; there is nothing to get
 * wrong and nothing to keep in step.
 */

// -----------------------------------------------------
// Organization pages
// -----------------------------------------------------

/** An organization's report list — its home, since reports live at the organization's root. */
export function organizationHref(organizationSlug: string): string {
  return `/orgs/${organizationSlug}`;
}

export function organizationMembersHref(organizationSlug: string): string {
  return `${organizationHref(organizationSlug)}/members`;
}

export function organizationSettingsHref(organizationSlug: string): string {
  return `${organizationHref(organizationSlug)}/settings`;
}

// -----------------------------------------------------
// Report pages
// -----------------------------------------------------

export function newReportHref(organizationSlug: string): string {
  return `${organizationHref(organizationSlug)}/reports/new`;
}

export function reportHref(organizationSlug: string, reportId: string): string {
  return `${organizationHref(organizationSlug)}/reports/${reportId}`;
}

/** The reports list, paged to the reports older than `reportId` — the last report on the page
 * being left. See `pagination.ts`. */
export function olderReportsHref(organizationSlug: string, reportId: string): string {
  return `${organizationHref(organizationSlug)}?older=${reportId}`;
}

/** The reports list, paged to the reports newer than `reportId` — the first report on the page
 * being left. See `pagination.ts`. */
export function newerReportsHref(organizationSlug: string, reportId: string): string {
  return `${organizationHref(organizationSlug)}?newer=${reportId}`;
}

// -----------------------------------------------------
// Poll endpoints
// -----------------------------------------------------
// Each sits beside the page it refreshes rather than under `/api`, which holds only writes — see
// `README.md` § Routes.

export function reportsPollHref(organizationSlug: string): string {
  return `${organizationHref(organizationSlug)}/poll`;
}

export function reportPollHref(organizationSlug: string, reportId: string): string {
  return `${reportHref(organizationSlug, reportId)}/poll`;
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

export function organizationApiHref(organizationSlug: string): string {
  return `/api/orgs/${organizationSlug}`;
}

export function reportsApiHref(organizationSlug: string): string {
  return `${organizationApiHref(organizationSlug)}/reports`;
}

export function reportApiHref(organizationSlug: string, reportId: string): string {
  return `${reportsApiHref(organizationSlug)}/${reportId}`;
}

export function cancelReportApiHref(organizationSlug: string, reportId: string): string {
  return `${reportApiHref(organizationSlug, reportId)}/cancel`;
}

export function retryReportApiHref(organizationSlug: string, reportId: string): string {
  return `${reportApiHref(organizationSlug, reportId)}/retry`;
}
