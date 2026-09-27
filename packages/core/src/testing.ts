import { createJsonLogger, type Logger, type LogLevel } from './log.ts';

export const LOCALHOST = '127.0.0.1';
export const UNREACHABLE_PORT = 1;
export const UNREACHABLE_LOCALHOST_URL = `http://${LOCALHOST}:${UNREACHABLE_PORT}`;

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
