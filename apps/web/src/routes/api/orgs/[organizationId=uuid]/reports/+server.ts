import type {
  Database,
  DatabaseExecutor,
  InputFileId,
  OrganizationId,
  ReportId,
  UserId,
} from '@gbd/db';
import { newInputFileId, newRejectedUploadId, newReportId, withTransaction } from '@gbd/db';
import {
  type BlobStore,
  putInputFile,
  putRejectedUpload,
  type StoredInputFile,
} from '@gbd/storage';
import { json } from '@sveltejs/kit';
import type { Transaction } from 'kysely';
import { reportHref } from '$lib/hrefs';
import type { ReportMetadata } from '$lib/reports/metadata';
import { type RejectedUploadRecord, userFacingRejection } from '$lib/reports/rejection';
import type { FileDescription, RawSubmission, UploadedFile } from '$lib/reports/submission';
import { readSubmission, validateSubmission } from '$lib/reports/submission';
import { requireAuth, requireOrganizationAccess } from '$lib/server/auth/guards';
import { database, withDbErrorHandling } from '$lib/server/db';
import {
  describeRateLimitExceeded,
  lockAndCheckReportRateLimit,
  type RateLimitExceeded,
} from '$lib/server/reports/rate-limit';
import { blobStore, withBlobStoreErrorHandling } from '$lib/server/storage';
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
    return json(userFacingRejection(outcome.rejection), { status: 400 });
  }

  const { organizationId, userId } = uploader;

  // Refuse before spending a blob write on an upload that's already over the rate limit.
  const initialRateLimitViolation = await withDbErrorHandling(
    () =>
      withTransaction(db, (transaction) =>
        lockAndCheckReportRateLimit(transaction, { organizationId, userId }),
      ),
    { action: 'check the report rate limit', context: { organizationId } },
  );
  if (initialRateLimitViolation) {
    const rejection = await recordRateLimitRejection(
      db,
      store,
      uploader,
      raw,
      outcome.file,
      initialRateLimitViolation,
    );
    return json(userFacingRejection(rejection), { status: 429 });
  }

  const reportId = newReportId();
  const inputFileId = newInputFileId();

  // Upload the objects before touching the database, so that no row
  // ever points at bytes that are not there.
  const stored = await withBlobStoreErrorHandling(
    () => putInputFile(store, { organizationId, reportId, inputFileId }, outcome.file.variants),
    { action: 'store an uploaded input file', context: { organizationId, reportId, inputFileId } },
  );

  const write = await withDbErrorHandling(
    () =>
      withTransaction(db, async (transaction) => {
        // Even though we already checked the rate limit, we must recheck because this
        // is a new database transaction.
        const exceeded = await lockAndCheckReportRateLimit(transaction, {
          organizationId,
          userId,
        });
        if (exceeded) {
          const rejection = await recordRateLimitRejection(
            transaction,
            store,
            uploader,
            raw,
            outcome.file,
            exceeded,
          );
          return { ok: false as const, rejection };
        }

        await insertReport(transaction, {
          reportId,
          organizationId,
          userId,
          inputFileId,
          metadata: outcome.metadata,
          stored,
          file: outcome.file,
        });
        return { ok: true as const };
      }),
    { action: 'record an accepted upload', context: { organizationId, reportId } },
  );

  // Always a rate-limit rejection: it's the only reason `write.ok` can be false here.
  if (!write.ok) return json(userFacingRejection(write.rejection), { status: 429 });

  return json(
    { reportId },
    { status: 201, headers: { location: reportHref(organizationId, reportId) } },
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
    stored: StoredInputFile;
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
      isModified: input.stored.isModified,
    })
    .execute();

  // Leaving `workerId`, `claimedAt` and `leaseRenewedAt` unset is what satisfies
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

async function recordRateLimitRejection(
  db: DatabaseExecutor,
  store: BlobStore,
  uploader: Uploader,
  raw: RawSubmission,
  file: FileDescription,
  exceeded: RateLimitExceeded,
): Promise<RejectedUploadRecord> {
  const rejection = describeRateLimitExceeded(exceeded);
  await recordRejection(
    db,
    store,
    uploader,
    raw,
    // We set `bytes: null` because there is no value in us seeing the input file
    // for a report that was rate limited.
    { fileDescription: file, bytes: null },
    rejection,
  );
  return rejection;
}

/** Keep a rejected upload: the bytes in the blob store, the reason and the raw metadata in
 * `rejected_upload`. */
async function recordRejection(
  db: DatabaseExecutor,
  store: BlobStore,
  uploader: Uploader,
  raw: RawSubmission,
  upload: { fileDescription: FileDescription | null; bytes: Uint8Array | null },
  rejection: RejectedUploadRecord,
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
        rejectionDetail: rejection.rejectionDetail ?? null,
      })
      .execute();
  } catch (cause) {
    // The blob store and the database are both only for our own records here, and the answer is
    // already the 400 telling the user why their file was rejected. So neither failing is raised —
    // which is why there is no `withDbErrorHandling` or `withBlobStoreErrorHandling` above.
    console.error('Could not record a rejected upload', {
      organizationId,
      reason: rejection.reason,
      cause,
    });
  }
}
