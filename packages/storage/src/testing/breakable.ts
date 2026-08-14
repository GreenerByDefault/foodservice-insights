/** A `BlobStore` that can be made to genuinely fail and genuinely recover on the same long-lived
 * handle, rather than swapping in a differently-configured object to fake the same thing.
 *
 * `unreachableBlobStore` covers a store that never worked. This covers one that worked, broke,
 * and came back.
 */

import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import type { Breakable } from '@gbd/db/testing';
import type { HttpRequest } from '@smithy/types';
import type { BlobStore } from '../client.ts';
import { initializeBlobStore, shutdownBlobStore } from '../client.ts';

export type { Breakable } from '@gbd/db/testing';

const FAST_STORAGE_LIMITS = {
  connectionTimeoutMs: 100,
  attemptTimeoutMs: 200,
  retryDelayBaseMs: 1,
  requestDeadlineMs: 1_000,
};

/** Port 1 is reserved and unused, so a connection to it is refused immediately rather than
 * hanging. */
const NOTHING_LISTENS_HERE = { hostname: '127.0.0.1', port: 1 };

/** A `BlobStore` whose requests can be redirected to a dead address and back, so `break()`
 * produces a genuine `BlobStoreError` and `restore()` lets the next request reach the real
 * test store (`S3_ENDPOINT`) again — the same client throughout.
 *
 * **Not a `node:net` proxy**, unlike `breakableDatabase` (`@gbd/db/testing`): Kong normalizes
 * every request's forwarded port back to its pinned `KONG_PORT_MAPS` value before Storage
 * verifies the SigV4 signature, so a request signed for a proxy port always fails
 * `SignatureDoesNotMatch`. Redirecting via the SDK's own `middlewareStack` instead moves the
 * connection *after* signing, so what the client signed for never changes.
 */
export async function breakableBlobStore(): Promise<Breakable<BlobStore>> {
  loadLocalEnv();

  const service = initializeBlobStore({
    endpoint: requireEnv('S3_ENDPOINT'),
    region: requireEnv('S3_REGION'),
    accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
    bucket: requireEnv('S3_BUCKET'),
    limits: FAST_STORAGE_LIMITS,
  });

  let broken = false;
  service.client.middlewareStack.add(
    (next) => async (args) => {
      if (broken) Object.assign(args.request as HttpRequest, NOTHING_LISTENS_HERE);
      return next(args);
    },
    // `finalizeRequest` runs after signing, so redirecting the destination here never
    // invalidates a signature computed against the real endpoint.
    { step: 'finalizeRequest', name: 'breakableRedirect' },
  );

  return {
    service,
    break() {
      broken = true;
    },
    restore() {
      broken = false;
    },
    async close() {
      shutdownBlobStore(service);
    },
  };
}
