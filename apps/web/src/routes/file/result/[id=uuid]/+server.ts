/** The stable link to a result file: a PDF, an XLSX, or one of a report's chart PNGs.
 *
 * **Deliberately unauthenticated**, and for the same reason as `/file/input` — see that route's
 * comment and ARCHITECTURE.md § File links.
 *
 * **Charts render inline; PDFs and XLSX download as attachments.** `result_file` has no
 * user-entered filename the way `input_file` does — the worker names it only by `kind` — so this
 * is the one place that decides what a result download is called: `{report name} - {kind}.{ext}`.
 * Charts get no `downloadFilename` at all, which is what keeps `Content-Disposition` off the
 * response so an `<img>` can point straight at this route. Because the redirect below is minted
 * fresh on every request, a chart embedded in a report page never goes stale — only the signed
 * URL expires, not the link the page holds.
 */

import type { DatabaseExecutor, ResultFileId } from '@gbd/db';
import { type BlobStore, RESULT_FILE_FORMATS } from '@gbd/storage';
import { error } from '@sveltejs/kit';
import { database } from '$lib/server/db';
import { redirectToSignedUrl } from '$lib/server/files';
import { blobStore } from '$lib/server/storage';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) =>
  await _downloadResultFile(database(), blobStore(), params.id as ResultFileId);

export async function _downloadResultFile(
  db: DatabaseExecutor,
  store: BlobStore,
  fileId: ResultFileId,
): Promise<Response> {
  const file = await db
    .selectFrom('resultFile')
    .innerJoin('analysisAttempt', 'analysisAttempt.id', 'resultFile.analysisAttemptId')
    .innerJoin('report', 'report.id', 'analysisAttempt.reportId')
    .select(['resultFile.storageKey', 'resultFile.kind', 'report.name'])
    .where('resultFile.id', '=', fileId)
    .where('report.deletedAt', 'is', null)
    .executeTakeFirst();

  if (!file) error(404, { message: 'That file is not available.' });

  const downloadFilename =
    file.kind === 'chart'
      ? undefined
      : `${file.name ?? 'report'} - ${file.kind}.${RESULT_FILE_FORMATS[file.kind].extension}`;

  return await redirectToSignedUrl(store, file.storageKey, downloadFilename);
}
