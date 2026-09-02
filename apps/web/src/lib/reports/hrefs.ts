/** The report flow's own URLs, built in one place so the same route isn't spelled out
 * independently by the loader that hands it out and the component that follows it.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

/** An organization's report list — also where an upload lands the user if the server's `created`
 * response carries no `location` header, and the "unsure whether that went through" fallback. */
export function organizationHref(organizationId: string): string {
  return `/orgs/${organizationId}`;
}

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
