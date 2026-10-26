import { createJsonLogger, type Logger, type LogLevel } from './log.ts';
import { HOUR_MS } from './time.ts';

export const LOCALHOST = '127.0.0.1';
export const UNREACHABLE_PORT = 1;
export const UNREACHABLE_LOCALHOST_URL = `http://${LOCALHOST}:${UNREACHABLE_PORT}`;

/** How long a per-run test resource (a database, bucket, data source or container) may exist before
 * a sweep considers it abandoned: no live Playwright run lasts this long. */
export const RUN_STALE_AFTER_MS = 2 * HOUR_MS;

/** A service that can be made to genuinely fail and genuinely recover on the same long-lived
 * handle, rather than swapping in a differently-configured object to fake the same thing. */
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

/** One record a logger wrote: the parsed JSON line, without the timestamp or pid and hostname. */
export type LogRecord = { readonly level: LogLevel; readonly msg?: string; [key: string]: unknown };

export type CollectingLogger = {
  /** Pass this wherever the code under test takes a logger. */
  readonly log: Logger;
  /** Every record written so far, oldest first. */
  readonly records: readonly LogRecord[];
  clear(): void;
};

/** A logger that keeps what it writes, so a test can assert `toEqual` on exactly what production
 * would print, serialization and redaction included.
 *
 * It logs at every level, so a `debug` line is as observable as an `error`.
 */
export function collectingLogger(): CollectingLogger {
  const records: LogRecord[] = [];
  const log = createJsonLogger('trace', (line) => records.push(JSON.parse(line)), { bare: true });
  return {
    log,
    records,
    clear: () => {
      records.length = 0;
    },
  };
}
