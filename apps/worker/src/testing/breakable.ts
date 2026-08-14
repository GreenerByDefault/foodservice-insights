/** A database or blob store that can be made to genuinely fail and genuinely recover on the same
 * long-lived handle, rather than swapping in a differently-configured object to fake the same
 * thing.
 *
 * `unreachableDatabase`/`unreachableBlobStore` (`@gbd/db/testing`, `@gbd/storage/testing`) cover a
 * service that never worked. This covers one that worked, broke, and came back — the shape every
 * fencing test and every parked-verdict recovery test needs, and that a swapped-in dependency
 * object can only imitate. `breakableDatabase` and `breakableBlobStore` get there by different
 * mechanisms — see each function for why.
 */

import { type AddressInfo, connect, createServer, type Server, type Socket } from 'node:net';
import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import type { Database } from '@gbd/db';
import { initializeDatabase, shutdownDatabase } from '@gbd/db';
import { type BlobStore, initializeBlobStore, shutdownBlobStore } from '@gbd/storage';
import type { HttpRequest } from '@smithy/types';
import type { Kysely } from 'kysely';

export type Breakable<T> = {
  readonly service: T;
  /** Make every subsequent request fail, as though the real service had gone down. */
  break(): void;
  /** Let requests reach the real service again. The pool or SDK client on top reconnects on its
   * own, the same way it would after a real network blip. */
  restore(): void;
  close(): Promise<void>;
};

type TcpProxy = {
  readonly port: number;
  break(): void;
  restore(): void;
  close(): Promise<void>;
};

/** Proxy every connection to `targetHost:targetPort` through a random local port, so `break()` can
 * sever what a test holds a handle to without touching the real database behind it — the shared
 * test stack, not something this file owns.
 */
async function startTcpProxy(targetHost: string, targetPort: number): Promise<TcpProxy> {
  let broken = false;
  const sockets = new Set<Socket>();

  const server: Server = createServer((client) => {
    if (broken) {
      client.destroy();
      return;
    }

    const upstream = connect(targetPort, targetHost);
    sockets.add(client);
    sockets.add(upstream);
    const detach = () => {
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => {
      upstream.destroy();
      detach();
    });
    upstream.on('close', () => {
      client.destroy();
      detach();
    });
    client.pipe(upstream);
    upstream.pipe(client);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    port,
    break() {
      broken = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    restore() {
      broken = false;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** A `Kysely<Database>` reachable only through a proxy in front of the real test database
 * (`DB_CONNECTION_STRING`), so `break()` produces genuine `pg` connection failures and `restore()`
 * lets the pool reconnect on its own.
 */
export async function breakableDatabase(): Promise<Breakable<Kysely<Database>>> {
  loadLocalEnv();
  const target = new URL(requireEnv('DB_CONNECTION_STRING'));
  const proxy = await startTcpProxy(target.hostname, Number(target.port));

  const proxied = new URL(target);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(proxy.port);
  const service = initializeDatabase(proxied.toString());

  return {
    service,
    break: proxy.break,
    restore: proxy.restore,
    async close() {
      await shutdownDatabase(service);
      await proxy.close();
    },
  };
}

/** Cuts the SDK's real deadlines down to the low hundreds of milliseconds. Without this, every
 * parked-upload assertion against a broken store would wait out `DEFAULT_LIMITS`' real 45-second
 * `requestDeadlineMs` (`packages/storage/src/client.ts`) before it could observe the park.
 */
const FAST_LIMITS = {
  connectionTimeoutMs: 100,
  attemptTimeoutMs: 200,
  retryDelayBaseMs: 1,
  requestDeadlineMs: 1_000,
};

/** Port 1 is reserved and unused, so a connection to it is refused immediately rather than
 * hanging — the same trick `unreachableBlobStore` uses, just made toggleable on one long-lived
 * client instead of baked into how it's built.
 */
const NOTHING_LISTENS_HERE = { hostname: '127.0.0.1', port: 1 };

/** A `BlobStore` whose requests can be redirected to a dead address and back, so `break()`
 * produces a genuine `BlobStoreError` and `restore()` lets the next request reach the real
 * test store (`S3_ENDPOINT`) again — the same client throughout.
 *
 * **Not a `node:net` proxy**, unlike `breakableDatabase`. The local Supabase stack's Kong
 * gateway is started with `KONG_PORT_MAPS` pinned to its published port, so it normalizes
 * every request's forwarded port back to that value before Storage verifies the request's
 * SigV4 signature — a request signed for any other port fails `SignatureDoesNotMatch`
 * regardless of where it physically lands. A proxy listening on a different port is
 * therefore a non-starter here. Redirecting the connection *after* signing, via the SDK's
 * own `middlewareStack`, never changes what the client signed for, so the mismatch never
 * arises: `initializeBlobStore` still points at the real endpoint, and only the destination
 * of an already-signed request moves.
 */
export async function breakableBlobStore(): Promise<Breakable<BlobStore>> {
  loadLocalEnv();

  const service = initializeBlobStore({
    endpoint: requireEnv('S3_ENDPOINT'),
    region: requireEnv('S3_REGION'),
    accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
    bucket: requireEnv('S3_BUCKET'),
    limits: FAST_LIMITS,
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
