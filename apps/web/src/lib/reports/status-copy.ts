/** What we call an attempt's status on screen. The registers differ because their contexts do:
 * a row is one of many, the page is about this report alone. */

import type { AnalysisAttemptStatus } from '@gbd/db';
import type { SettledStatus } from './attempt-status.ts';

/** The badge beside a report in the list. */
export const STATUS_LABELS: Record<AnalysisAttemptStatus, string> = {
  pending: 'Queued',
  processing: 'Processing',
  succeeded: 'Ready',
  failed: "Couldn't finish",
  canceled: 'Stopped',
};

/** Announced by the list, after the report's name: "Q3 orders is ready". */
export const SETTLED_IN_LIST: Record<SettledStatus, string> = {
  succeeded: 'is ready',
  failed: "couldn't finish",
  canceled: 'was stopped',
};

/** Announced by the report page, which has only the one report to talk about. */
export const SETTLED_ON_PAGE: Record<SettledStatus, string> = {
  succeeded: 'Your report is ready',
  failed: 'Your report could not be finished',
  canceled: 'This report was stopped',
};
