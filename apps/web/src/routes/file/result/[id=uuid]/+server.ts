/** The stable, unauthenticated link to a result file. */

import type { DatabaseExecutor, ResultFileId } from '@gbd/db';
import { type BlobStore, RESULT_FILE_FORMATS } from '@gbd/storage';
import { error } from '@sveltejs/kit';
import { database, withDbErrorHandling } from '$lib/server/db';
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
  const file = await withDbErrorHandling(
    () =>
      db
        .selectFrom('resultFile')
        .innerJoin('analysisAttempt', 'analysisAttempt.id', 'resultFile.analysisAttemptId')
        .innerJoin('report', 'report.id', 'analysisAttempt.reportId')
        .select(['resultFile.storageKey', 'resultFile.kind', 'report.name'])
        .where('resultFile.id', '=', fileId)
        .where('report.deletedAt', 'is', null)
        .executeTakeFirst(),
    { action: 'load result file for download', context: { fileId } },
  );

  if (!file) error(404, { message: 'That file is not available.' });

  const downloadFilename = `${file.name ?? 'report'}.${RESULT_FILE_FORMATS[file.kind].extension}`;

  return await redirectToSignedUrl(store, file.storageKey, downloadFilename);
}
