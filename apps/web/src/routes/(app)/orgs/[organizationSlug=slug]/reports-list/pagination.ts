import type { ReportId } from '@gbd/db';
import * as v from 'valibot';

const CursorSchema = v.pipe(v.string(), v.uuid());

export type ReportsCursor =
  | { direction: 'newest' }
  | { direction: 'older' | 'newer'; cursor: ReportId };

/** Parses the org page's `?older=` / `?newer=` query params into a cursor.
 *
 * A malformed cursor — missing, or present but not a UUID — falls back to the newest page rather
 * than erroring: the query is org-scoped either way so there is nothing to leak, and a stale
 * bookmark does not deserve an error page. Both params set prefers `older`.
 */
export function parseCursor(searchParams: URLSearchParams): ReportsCursor {
  const older = searchParams.get('older');
  if (older !== null && v.is(CursorSchema, older)) {
    return { direction: 'older', cursor: older as ReportId };
  }

  const newer = searchParams.get('newer');
  if (newer !== null && v.is(CursorSchema, newer)) {
    return { direction: 'newer', cursor: newer as ReportId };
  }

  return { direction: 'newest' };
}
