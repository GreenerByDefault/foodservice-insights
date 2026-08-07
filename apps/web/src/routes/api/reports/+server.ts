/** Accepting an upload: one report, its input file, and the attempt a worker will claim.
 *
 * A `+server.ts` rather than a form action, per ARCHITECTURE.md § Web app. It lives under `/api`
 * because SvelteKit does not allow a `+server.ts` beside a `+page.svelte`, and `/reports` is
 * where the list page will go.
 */

import type { DatabaseExecutor, InputFileId, OrganizationId, ReportId, UserId } from '@gbd/db';
import { newInputFileId, newRejectedUploadId, newReportId, withTransaction } from '@gbd/db';
import { type BlobStore, putInputFile, putRejectedUpload, type StoredFile } from '@gbd/storage';
import { error, json } from '@sveltejs/kit';
import type {
  RawSubmission,
  Rejection,
  ReportMetadata,
  UploadedFile,
} from '$lib/reports/submission';
import { readSubmission, validateSubmission } from '$lib/reports/submission';
import { database } from '$lib/server/db';
import { requireSession, type Session } from '$lib/server/session';
import { blobStore } from '$lib/server/storage';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) =>
  await _createReport(database(), blobStore(), requireSession(locals), request);

/** Store an accepted upload, or record a rejected one and answer 400.
 *
 * Takes its database and blob store rather than reaching for them, so a test can hand it a
 * rolled-back transaction and drive the whole handler.
 */
export async function _createReport(
  db: DatabaseExecutor,
  store: BlobStore,
  session: Session,
  request: Request,
): Promise<Response> {
  const raw = readSubmission(await request.formData());
  const outcome = await validateSubmission(raw);

  if (!outcome.ok) {
    await recordRejection(db, store, session, raw, outcome.file, outcome.rejection);
    error(400, { message: outcome.rejection.message, code: outcome.rejection.reason });
  }

  const organizationId = session.organization.id;
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

  await withTransaction(db, async (transaction) => {
    await insertReport(transaction, {
      reportId,
      organizationId,
      userId: session.userId,
      inputFileId,
      metadata: outcome.metadata,
      stored,
      originalFilename: outcome.file.originalFilename,
    });
  });

  return json({ reportId }, { status: 201, headers: { location: `/reports/${reportId}` } });
}

/** Every row one accepted upload produces.
 *
 * One transaction, and that is the contract with the worker: a claim query must never find a
 * `pending` attempt whose `input_file` has not committed yet, because it has no way to wait for
 * one. `withTransaction` is what lets a test still call this with its own transaction —
 * `packages/db/src/transactions.test.ts` is what covers the atomicity itself.
 */
async function insertReport(
  db: DatabaseExecutor,
  input: {
    reportId: ReportId;
    organizationId: OrganizationId;
    userId: UserId;
    inputFileId: InputFileId;
    metadata: ReportMetadata;
    stored: StoredFile;
    originalFilename: string;
  },
): Promise<void> {
  await db
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
  await db
    .insertInto('inputFile')
    .values({
      id: input.inputFileId,
      reportId: input.reportId,
      storageKey: input.stored.storageKey,
      byteSize: input.stored.byteSize,
      contentType: input.stored.contentType,
      originalFilename: input.originalFilename,
      checksumSha256: input.stored.checksumSha256,
    })
    .execute();

  // Leaving `workerId`, `lockedAt` and `lastHeartbeatAt` unset is what satisfies
  // `analysis_attempt_pending_is_unclaimed`; number 1 is what the first-attempt trigger wants.
  await db
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
 * Phase 1 can always do this, because the organization comes from the session. Once a request
 * may name its own organization, that has to be authorized *before* validation — the column is
 * `NOT NULL` with a foreign key, so there is nothing to record against an unknown one.
 */
async function recordRejection(
  db: DatabaseExecutor,
  store: BlobStore,
  session: Session,
  raw: RawSubmission,
  file: UploadedFile | null,
  rejection: Rejection,
): Promise<void> {
  const organizationId = session.organization.id;

  try {
    const rejectedUploadId = newRejectedUploadId();
    const stored = file
      ? await putRejectedUpload(store, { organizationId, rejectedUploadId }, file.bytes)
      : undefined;

    // The raw strings, not the parsed values: the row exists precisely because they did not
    // parse, and the text columns are typed to hold whatever arrived.
    await db
      .insertInto('rejectedUpload')
      .values({
        id: rejectedUploadId,
        organizationId,
        createdByUserId: session.userId,
        reportName: raw.name,
        reportSiteName: raw.siteName,
        reportCountsBasis: raw.countsBasis,
        reportMonthlyCounts: asJsonOrNull(raw.monthlyCounts),
        reportUnitSystem: raw.unitSystem,
        inputFileStorageKey: stored?.storageKey ?? null,
        inputFileByteSize: stored?.byteSize ?? null,
        inputFileOriginalFilename: file?.originalFilename ?? null,
        rejectionReason: rejection.reason,
        rejectionDetail: rejection.detail ?? null,
      })
      .execute();
  } catch (cause) {
    // Bookkeeping, so it must not change the answer. The upload is invalid either way, and a
    // 500 here would tell the user to retry something that cannot ever succeed.
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
