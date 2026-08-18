import { type DatabaseExecutor, newResultFileId, type ResultFileKind, type UserId } from '@gbd/db';
import { aChecksum, insertAppUser } from '@gbd/db/testing';
import { RESULT_FILE_FORMATS } from '@gbd/storage';
import type { ResultFileRecord } from '../queue.ts';

/** A worker id unique enough that two tests never collide, even when both are `aWorkerId()` and
 * neither names the other. */
export function aWorkerId(): string {
  return `test-worker-${crypto.randomUUID()}`;
}

/** A user who can be `analysis_attempt.requested_by_user_id`, with the email address the
 * notification sweep is supposed to find. `insertAppUser` doesn't return it — `app_user` mirrors
 * `auth.users`, which owns the column — so this reads it back. */
export async function insertRequester(
  db: DatabaseExecutor,
): Promise<{ id: UserId; email: string }> {
  const user = await insertAppUser(db);
  const { email } = await db
    .selectFrom('auth.users')
    .select('email')
    .where('id', '=', user.id)
    .executeTakeFirstOrThrow();
  // `insertAppUser` always gives its `auth.users` row a synthetic `<uuid>@example.test` address.
  return { id: user.id, email: email as string };
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
