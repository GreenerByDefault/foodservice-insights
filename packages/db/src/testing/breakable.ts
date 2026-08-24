/** A database that can be made to genuinely fail and genuinely recover on the same long-lived
 * handle, rather than swapping in a differently-configured object to fake the same thing.
 *
 * `unreachableDatabase` covers a database that never worked. This covers one that worked,
 * broke, and came back.
 */

import { type AddressInfo, connect, createServer, type Server, type Socket } from 'node:net';
import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import type { Kysely } from 'kysely';
import { initializeDatabase, shutdownDatabase } from '../client.ts';
import type { Database } from '../schema.ts';

export type Breakable<T> = {
  readonly service: T;
  /** Make every subsequent request fail, as though the real service had gone down. */
  break(): void;
  /** Let requests reach the real service again. The pool or SDK client on top reconnects on its
   * own, the same way it would after a real network blip. */
  restore(): void;
  close(): Promise<void>;
};

/** Open a `Breakable`, run `body` against it, and close it whether `body` throws or not. */
export async function withBreakable<S>(
  open: () => Promise<Breakable<S>>,
  body: (breakable: Breakable<S>) => Promise<void>,
): Promise<void> {
  const breakable = await open();
  try {
    await body(breakable);
  } finally {
    await breakable.close();
  }
}

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
  const service = initializeDatabase({ connectionString: proxied.toString() });

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
