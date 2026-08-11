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

export type Uploader = { organizationId: OrganizationId; userId: UserId };

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

  // Upload the object before touching the database, so that no row
  // ever points at bytes that are not there.
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
 * `rejected_upload`. */
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

    // We store the raw strings, not the parsed values.
    await db
      .insertInto('rejectedUpload')
      .values({
        id: rejectedUploadId,
        organizationId,
        createdByUserId: userId,
        reportName: raw.name,
        reportSiteName: raw.siteName,
        reportCountsBasis: raw.countsBasis,
        reportMonthlyCounts: raw.monthlyCounts,
        reportUnitSystem: raw.unitSystem,
        inputFileStorageKey: stored?.storageKey ?? null,
        inputFileByteSize: upload.fileDescription?.byteSize ?? null,
        inputFileOriginalFilename: upload.fileDescription?.originalFilename ?? null,
        rejectionReason: rejection.reason,
        rejectionDetail: rejection.detail ?? null,
      })
      .execute();
  } catch (cause) {
    // We do not error() if the database fails because the database is only for
    // our own recording with rejections. This is why we don't use withDbErrorHandling.
    console.error('Could not record a rejected upload', {
      organizationId,
      reason: rejection.reason,
      cause,
    });
  }
}
