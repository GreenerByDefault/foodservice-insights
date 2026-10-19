/** A `BlobStore` that can be made to genuinely fail and genuinely recover on the same long-lived
 * handle, rather than swapping in a differently-configured object to fake the same thing.
 *
 * `unreachableBlobStore` covers a store that never worked. This covers one that worked, broke,
 * and came back.
 */

import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import { LOCALHOST, UNREACHABLE_PORT } from '@gbd/core/testing';
import type { Breakable } from '@gbd/db/testing';
import type { HttpRequest } from '@smithy/types';
import type { BlobStore } from '../client.ts';
import { initializeBlobStore, shutdownBlobStore } from '../client.ts';

export type { Breakable } from '@gbd/db/testing';

const NOTHING_LISTENS_HERE = { hostname: LOCALHOST, port: UNREACHABLE_PORT };

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
    // Only the backoff is shortened. The broken address refuses the connection outright, so a
    // connection or attempt timeout never decides how fast `break()` fails; one would only cap
    // the restored path against the real store, whose first request on a cold CI runner has taken
    // over 400ms. A 200ms cap there failed every attempt.
    limits: { retryDelayBaseMs: 1 },
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
