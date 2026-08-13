/** Where every file lives in the bucket.
 *
 * ```
 * org/{organization_id}
 *     /rejected-upload/{rejected_upload_id}.csv
 *     /report/{report_id}
 *         /input/{input_file_id}.csv
 *         /input/{input_file_id}-original.csv
 *         /analysis-attempt/{analysis_attempt_id}
 *             /result/{result_file_id}.{ext}
 * ```
 *
 * Two rules hold it together:
 *
 * 1. **Everything an organization owns is under one prefix**, so deleting an organization's files
 *    is a single `deletePrefix`.
 * 2. **A segment is an id or a fixed name, never anything a user typed** — filenames, report names
 *    and chart keys stay in the database. So a key needs no escaping, and branded ids mean it
 *    needs no validation: an `OrganizationId` cannot have come from a request body.
 */

import type {
  AnalysisAttemptId,
  InputFileId,
  OrganizationId,
  RejectedUploadId,
  ReportId,
  ResultFileId,
  ResultFileKind,
} from '@gbd/db';

export const NORMALIZED_CSV_CONTENT_TYPE = 'text/csv';

/** Not `text/csv`: a rejected upload's bytes may be `csv_injection`, and the original input
 * file's encoding may not be UTF-8 — neither is safe for a browser to render as text.
 */
export const OPAQUE_CSV_CONTENT_TYPE = 'application/octet-stream';

/** How each kind of result file is stored.
 *
 * Keyed by the database's own `result_file_kind`, so the `kind` written to `result_file` and the
 * extension its key ends in come from one entry.
 *
 * **Open:** charts are PNG until the AI library's output has been reviewed.
 */
export const RESULT_FILE_FORMATS = {
  pdf: { extension: 'pdf', contentType: 'application/pdf' },
  xlsx: {
    extension: 'xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  chart: { extension: 'png', contentType: 'image/png' },
} as const satisfies Record<ResultFileKind, { extension: string; contentType: string }>;

/** The trailing slash is load-bearing: `deletePrefix` matches the string, not path segments, so
 * `org/{id}` alone would reach into a differently-named neighbour.
 */
export function organizationPrefix(organizationId: OrganizationId): string {
  return `org/${organizationId}/`;
}

export function rejectedUploadKey(ids: {
  organizationId: OrganizationId;
  rejectedUploadId: RejectedUploadId;
}): string {
  return organizationScoped(ids.organizationId, 'rejected-upload', `${ids.rejectedUploadId}.csv`);
}

export function normalizedInputFileKey(ids: {
  organizationId: OrganizationId;
  reportId: ReportId;
  inputFileId: InputFileId;
}): string {
  return organizationScoped(
    ids.organizationId,
    'report',
    ids.reportId,
    'input',
    `${ids.inputFileId}.csv`,
  );
}

/** The upload as the user sent it, kept only for date-order-inference forensics. See this file's
 * header — no row anywhere holds this key.
 */
export function originalInputFileKey(ids: {
  organizationId: OrganizationId;
  reportId: ReportId;
  inputFileId: InputFileId;
}): string {
  return organizationScoped(
    ids.organizationId,
    'report',
    ids.reportId,
    'input',
    `${ids.inputFileId}-original.csv`,
  );
}

export function resultFileKey(ids: {
  organizationId: OrganizationId;
  reportId: ReportId;
  analysisAttemptId: AnalysisAttemptId;
  resultFileId: ResultFileId;
  kind: ResultFileKind;
}): string {
  return organizationScoped(
    ids.organizationId,
    'report',
    ids.reportId,
    'analysis-attempt',
    ids.analysisAttemptId,
    'result',
    `${ids.resultFileId}.${RESULT_FILE_FORMATS[ids.kind].extension}`,
  );
}

/** Join `segments` beneath an organization's prefix, so a builder added later cannot forget
 * rule 1.
 */
function organizationScoped(organizationId: OrganizationId, ...segments: string[]): string {
  return `${organizationPrefix(organizationId)}${segments.join('/')}`;
}
