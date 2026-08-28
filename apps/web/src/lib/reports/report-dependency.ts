import type { ReportId } from '@gbd/db';

/** The `depends()`/`invalidate()` key naming one report's load, so an action that changes it
 * re-runs just this load. */
export function reportDependencyKey(reportId: ReportId): string {
  return `report:${reportId}`;
}
