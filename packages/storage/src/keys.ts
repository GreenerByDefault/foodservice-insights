/** Where every file lives in the bucket.
 *
 * ```
 * org/{organization_id}
 *     /rejected-upload/{rejected_upload_id}.csv
 *     /report/{report_id}
 *         /input/{input_file_id}.csv
 *         /analysis-attempt/{analysis_attempt_id}
 *             /result/{result_file_id}.{ext}
 * ```
 *
 * Three rules hold it together:
 *
 * 1. **Everything an organization owns is under one prefix**, so deleting an organization's files
 *    is a single `deletePrefix`.
 * 2. **A segment is an id or a fixed name, never anything a user typed** — filenames, report names
 *    and chart keys stay in the database. So a key needs no escaping, and branded ids mean it
 *    needs no validation: an `OrganizationId` cannot have come from a request body.
 * 3. **Keys are only ever built on the write path.** Every reader takes `storage_key` off the database
 *    row, so changing the layout later would not strand the objects already written under the old one.
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

export const CSV_CONTENT_TYPE = 'text/csv';

/** Deliberately not `text/csv`. An upload is rejected for what it turned out to be — two of the
 * reasons are `unparseable` and `csv_injection` — so its bytes are labelled as the opaque blob
 * they are rather than as something a browser might interpret.
 */
export const REJECTED_UPLOAD_CONTENT_TYPE = 'application/octet-stream';

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

export function inputFileKey(ids: {
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
