/** The stable link to an uploaded input file.
 *
 * **Deliberately unauthenticated.** REQUIREMENTS.md makes these links public and non-expiring —
 * anyone holding one can download the file — so Supabase Auth will not touch this route. What it
 * does check is whether the file is still *accessible*: a soft-deleted report's links stop
 * working while its objects stay in the blob store for debugging. That is the whole reason
 * downloads go through the server instead of a public bucket, per ARCHITECTURE.md § File links.
 */

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
