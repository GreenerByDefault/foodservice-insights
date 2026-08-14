import {
  type AnalysisAttemptId,
  type DatabaseExecutor,
  newResultFileId,
  type ResultFileKind,
} from '@gbd/db';
import { aChecksum } from '@gbd/db/testing';
import { RESULT_FILE_FORMATS } from '@gbd/storage';
import type { ResultFileRecord } from '../queue.ts';

/** A worker id unique enough that two tests never collide, even when both are `aWorkerId()` and
 * neither names the other. */
export function aWorkerId(): string {
  return `test-worker-${crypto.randomUUID()}`;
}

export async function readAttemptRow(db: DatabaseExecutor, attemptId: AnalysisAttemptId) {
  return await db
    .selectFrom('analysisAttempt')
    .selectAll()
    .where('id', '=', attemptId)
    .executeTakeFirstOrThrow();
}

/** Stands in for what `putResultFile` returns, down to taking its extension and content type from
 * the same map the upload would. */
export function aResultFile(
  kind: ResultFileKind = 'pdf',
  chartKey = 'total_spend',
): ResultFileRecord {
  const { extension, contentType } = RESULT_FILE_FORMATS[kind];
  const stored = {
    id: newResultFileId(),
    storageKey: `org/test/${crypto.randomUUID()}.${extension}`,
    byteSize: 2_048,
    contentType,
    checksumSha256: aChecksum(),
  };
  return kind === 'chart' ? { ...stored, kind, chartKey } : { ...stored, kind };
}
