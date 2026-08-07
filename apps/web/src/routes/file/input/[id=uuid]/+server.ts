/** The stable, unauthenticated link to an uploaded input file. */

import type { DatabaseExecutor, InputFileId } from '@gbd/db';
import type { BlobStore } from '@gbd/storage';
import { error } from '@sveltejs/kit';
import { database } from '$lib/server/db';
import { redirectToSignedUrl } from '$lib/server/files';
import { blobStore } from '$lib/server/storage';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) =>
  await _downloadInputFile(database(), blobStore(), params.id as InputFileId);

export async function _downloadInputFile(
  db: DatabaseExecutor,
  store: BlobStore,
  fileId: InputFileId,
): Promise<Response> {
  const file = await db
    .selectFrom('inputFile')
    .innerJoin('report', 'report.id', 'inputFile.reportId')
    .select(['inputFile.storageKey', 'inputFile.originalFilename'])
    .where('inputFile.id', '=', fileId)
    .where('report.deletedAt', 'is', null)
    .executeTakeFirst();

  if (!file) error(404, { message: 'That file is not available.' });

  return await redirectToSignedUrl(store, file.storageKey, file.originalFilename);
}
