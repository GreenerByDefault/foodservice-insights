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
 * Three rules hold the layout together:
 *
 * 1. **Everything an organization owns is under one prefix**, so deleting an organization's files
 *    is a single `deletePrefix(store, organizationPrefix(id))`. `organizationScoped` makes that
 *    true by construction rather than by every builder remembering it.
 * 2. **A path segment is an id or a fixed name, never anything a user typed.** Filenames, report
 *    names and chart keys all live in the database instead. So a key needs no escaping, and the
 *    branded id types mean it needs no validation either — an `OrganizationId` can only have come
 *    from a row or from `newInputFileId`-style minting, never from a request body.
 * 3. **Keys are only ever built on the write path.** Every reader — the file download route, the
 *    worker fetching its input — takes `storage_key` off the row instead. That means these
 *    builders have exactly three call sites, and that changing the layout later would not strand
 *    the objects already written under the old one.
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

/** What an input file is stored and served as.
 *
 * Only CSV, because that is the only thing the web server accepts — see
 * [`ARCHITECTURE.md`](../../../ARCHITECTURE.md#input-file-upload-and-validation) for why the
 * client converts XLSX rather than us taking it.
 */
export const CSV_CONTENT_TYPE = 'text/csv';

/** What a rejected upload is stored as.
 *
 * Deliberately not `text/csv`: an upload is rejected precisely because of what it turned out to
 * be, and `unparseable` and `csv_injection` are two of the reasons. These bytes are kept only for
 * debugging, so they are labelled as the opaque blob they are rather than as something a browser
 * might feel invited to interpret. What the user called the file is in
 * `rejected_upload.input_file_original_filename`.
 */
export const REJECTED_UPLOAD_CONTENT_TYPE = 'application/octet-stream';

/** How each kind of result file is stored, keyed by the database's own `result_file_kind`.
 *
 * Keyed by that enum rather than by a extension-shaped union of our own, so there is one
 * vocabulary for "what kind of file is this": the `kind` written to `result_file` and the
 * extension its key ends in provably come from the same entry, and no caller can ask for a
 * result file in a format no result file has.
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

/** Everything an organization owns, and nothing else, starts with this.
 *
 * The trailing slash is load-bearing. `deletePrefix` matches on the string, not on path segments,
 * so without it `org/{id}` would also reach into a differently-named neighbour.
 *
 * One positional parameter rather than the object the other builders take, because a single
 * argument cannot be passed in the wrong place.
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

/** Join `segments` beneath an organization's prefix.
 *
 * Every builder above goes through this instead of assembling its own string, so a builder added
 * later cannot forget the organization prefix that rule 1 depends on.
 */
function organizationScoped(organizationId: OrganizationId, ...segments: string[]): string {
  return `${organizationPrefix(organizationId)}${segments.join('/')}`;
}
