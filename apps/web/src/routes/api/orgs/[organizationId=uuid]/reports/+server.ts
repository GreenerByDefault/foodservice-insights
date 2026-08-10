/** Accepting an upload: one report, its input file, and the attempt a worker will claim. */

import type {
  Database,
  DatabaseExecutor,
  InputFileId,
  OrganizationId,
  ReportId,
  UserId,
} from '@gbd/db';
import { newInputFileId, newRejectedUploadId, newReportId, withTransaction } from '@gbd/db';
import { type BlobStore, putInputFile, putRejectedUpload, type StoredFile } from '@gbd/storage';
import { error, json } from '@sveltejs/kit';
import type { Transaction } from 'kysely';
import type {
  FileDescription,
  RawSubmission,
  Rejection,
  ReportMetadata,
  UploadedFile,
} from '$lib/reports/submission';
import { readSubmission, validateSubmission } from '$lib/reports/submission';
import { requireAuth, requireOrganizationAccess } from '$lib/server/auth/guards';
import { database, withDbErrorHandling } from '$lib/server/db';
import { blobStore } from '$lib/server/storage';
import type { RequestHandler } from './$types';

/** Who is uploading, and where to. */
export type Uploader = { organizationId: OrganizationId; userId: UserId };

/** The upload: validate, store the file, write the rows, enqueue the first attempt. Answers 201
 * with a `location` header pointing at the new report.
 *
 * Authorize the organization *before* validating anything, because a file that fails validation is
 * still recorded — and `rejected_upload.organization_id` is `NOT NULL` with a foreign key, so there
 * is nowhere to write the rejection until the organization is known to be real and the caller's.
 *
 * The file arrives on this request rather than through a presigned URL: at a 10MB cap the server has
 * to read it to validate it anyway.
 */
export const POST: RequestHandler = async ({ request, params, locals }) => {
  const auth = requireAuth(locals);
  const organizationId = params.organizationId as OrganizationId;
  requireOrganizationAccess(auth, organizationId);

  return await _createReport(
    database(),
    blobStore(),
    { organizationId, userId: auth.user.id },
    request,
  );
};

/** Store an accepted upload, or record a rejected one and answer 400. */
export async function _createReport(
  db: DatabaseExecutor,
  store: BlobStore,
  uploader: Uploader,
  request: Request,
): Promise<Response> {
  const raw = readSubmission(await request.formData());
  const outcome = await validateSubmission(raw);

  if (!outcome.ok) {
    await recordRejection(db, store, uploader, raw, outcome, outcome.rejection);
    error(400, { message: outcome.rejection.message, code: outcome.rejection.reason });
  }

  const { organizationId, userId } = uploader;
  const reportId = newReportId();
  const inputFileId = newInputFileId();

  // The object goes first, so no row ever points at bytes that are not there. The reverse
  // failure — the transaction below not committing — orphans the object, which
  // REQUIREMENTS.md § Out of scope accepts. It is deliberately outside the transaction: a
  // 10MB upload must not hold a database connection open while it happens.
  const stored = await putInputFile(
    store,
    { organizationId, reportId, inputFileId },
    outcome.file.bytes,
  );

  await withDbErrorHandling(
    () =>
      withTransaction(db, (transaction) =>
        insertReport(transaction, {
          reportId,
          organizationId,
          userId,
          inputFileId,
          metadata: outcome.metadata,
          stored,
          file: outcome.file,
        }),
      ),
    { action: 'record an accepted upload', context: { organizationId, reportId } },
  );

  return json(
    { reportId },
    { status: 201, headers: { location: `/orgs/${organizationId}/reports/${reportId}` } },
  );
}

/** Every row one accepted upload produces.
 *
 * The contract with the worker is that a claim query must never find a `pending` attempt whose
 * `input_file` has not committed yet, because it has no way to wait for one.
 */
async function insertReport(
  transaction: Transaction<Database>,
  input: {
    reportId: ReportId;
    organizationId: OrganizationId;
    userId: UserId;
    inputFileId: InputFileId;
    metadata: ReportMetadata;
    stored: StoredFile;
    file: UploadedFile;
  },
): Promise<void> {
  await transaction
    .insertInto('report')
    .values({
      id: input.reportId,
      organizationId: input.organizationId,
      createdByUserId: input.userId,
      name: input.metadata.name,
      siteName: input.metadata.siteName,
      countsBasis: input.metadata.countsBasis,
      monthlyCounts: input.metadata.monthlyCounts,
      unitSystem: input.metadata.unitSystem,
    })
    .execute();

  // Every column but the filename is what the blob store recorded, never what the client
  // claimed — including the content type.
  await transaction
    .insertInto('inputFile')
    .values({
      id: input.inputFileId,
      reportId: input.reportId,
      storageKey: input.stored.storageKey,
      byteSize: input.stored.byteSize,
      contentType: input.stored.contentType,
      originalFilename: input.file.originalFilename,
      checksumSha256: input.stored.checksumSha256,
    })
    .execute();

  // Leaving `workerId`, `lockedAt` and `lastHeartbeatAt` unset is what satisfies
  // `analysis_attempt_pending_is_unclaimed`; number 1 is what the first-attempt trigger wants.
  await transaction
    .insertInto('analysisAttempt')
    .values({
      reportId: input.reportId,
      attemptNumber: 1,
      status: 'pending',
      requestedByUserId: input.userId,
    })
    .execute();
}

/** Keep a rejected upload: the bytes in the blob store, the reason and the raw metadata in
 * `rejected_upload`. REQUIREMENTS.md § Errors during upload and processing requires both.
 *
 * `bytes` is null for a file we refused without reading — see `validateSubmission` — so the row
 * records what was attempted while the blob store gets nothing.
 */
async function recordRejection(
  db: DatabaseExecutor,
  store: BlobStore,
  uploader: Uploader,
  raw: RawSubmission,
  upload: { fileDescription: FileDescription | null; bytes: Uint8Array | null },
  rejection: Rejection,
): Promise<void> {
  const { organizationId, userId } = uploader;

  try {
    const rejectedUploadId = newRejectedUploadId();
    const stored = upload.bytes
      ? await putRejectedUpload(store, { organizationId, rejectedUploadId }, upload.bytes)
      : undefined;

    // The raw strings, not the parsed values: the row exists precisely because they did not
    // parse, and the text columns are typed to hold whatever arrived.
    await db
      .insertInto('rejectedUpload')
      .values({
        id: rejectedUploadId,
        organizationId,
        createdByUserId: userId,
        reportName: raw.name,
        reportSiteName: raw.siteName,
        reportCountsBasis: raw.countsBasis,
        reportMonthlyCounts: asJsonOrNull(raw.monthlyCounts),
        reportUnitSystem: raw.unitSystem,
        inputFileStorageKey: stored?.storageKey ?? null,
        inputFileByteSize: upload.fileDescription?.byteSize ?? null,
        inputFileOriginalFilename: upload.fileDescription?.originalFilename ?? null,
        rejectionReason: rejection.reason,
        rejectionDetail: rejection.detail ?? null,
      })
      .execute();
  } catch (cause) {
    // Bookkeeping, so it must not change the answer — which is why this does not go through
    // `withDbErrorHandling`. The upload is invalid either way, and a 500 here would tell the
    // user to retry something that cannot ever succeed.
    console.error('Could not record a rejected upload', {
      organizationId,
      reason: rejection.reason,
      cause,
    });
  }
}

/** `report_monthly_counts` is `jsonb`, so text that is not JSON cannot be stored in it at all.
 * What it was is in `rejection_detail` instead.
 */
function asJsonOrNull(text: string | null): string | null {
  if (text === null) return null;
  try {
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
}
