/** Structured logging: one JSON object per line on stdout.
 *
 * **Node only**, like `env.ts`. Browser code imports this package's root, so this lives at a
 * subpath the browser never reaches.
 *
 * Stdout is the whole interface. Every host we might deploy to reads it, and the process never
 * learns where its lines go. That is why there are no pino transports here: a transport runs in a
 * worker thread that resolves its target by name at runtime, which breaks under a bundler and
 * starts another thread on every Vite reload. The destination is synchronous, so a process that
 * calls `process.exit` has already flushed what it logged.
 *
 * Considered and not done: a first-party logger, per AGENTS.md's supply-chain rule. Serializers,
 * redaction and child bindings are most of a logger, and they are what we would rewrite. Also
 * rejected: OpenTelemetry, which is three libraries plus a collector, for traces nothing here
 * needs. These lines carry the same ids.
 */

import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import pino, {
  type DestinationStream,
  type LevelWithSilent,
  type Logger,
  type LoggerOptions,
} from 'pino';

export type { Logger } from 'pino';

export type LogLevel = LevelWithSilent;
export type LogFormat = 'json' | 'pretty';

export type LogSettings = {
  readonly level: LogLevel;
  readonly format: LogFormat;
};

/** What `LOG_LEVEL` and `LOG_FORMAT` hold, unparsed. */
export type RawLogSettings = {
  readonly level: string | undefined;
  readonly format: string | undefined;
};

const LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
const FORMATS: readonly LogFormat[] = ['json', 'pretty'];

/** The keys an error rides under, each with the error serializer. */
const ERROR_KEYS: readonly string[] = ['err', 'error', 'cause'];

/** Parse `LOG_LEVEL` and `LOG_FORMAT`. Production sets neither; a typo throws at startup. */
export function parseLogSettings(raw: RawLogSettings): LogSettings {
  return {
    level: parseChoice('LOG_LEVEL', raw.level, LEVELS, 'info'),
    format: parseChoice('LOG_FORMAT', raw.format, FORMATS, 'json'),
  };
}

function parseChoice<T extends string>(
  name: string,
  value: string | undefined,
  choices: readonly T[],
  fallback: T,
): T {
  if (!value) return fallback;
  const choice = choices.find((candidate) => candidate === value);
  if (choice === undefined) {
    throw new Error(`Unknown ${name} '${value}'. Expected one of: ${choices.join(', ')}.`);
  }
  return choice;
}

export function createLogger(settings: LogSettings): Logger {
  switch (settings.format) {
    case 'json': {
      const stdout = pino.destination({ dest: 1, sync: true });
      return createJsonLogger(settings.level, (line) => stdout.write(line));
    }
    case 'pretty':
      return pino(loggerOptions(settings.level), loadPrettyStream());
  }
}

/** A JSON logger writing each record, bounded to `MAX_RECORD_BYTES`, to `write`.
 *
 * `bare` leaves out the timestamp and the pid and hostname bindings, which is what the collecting
 * logger in `@gbd/core/testing` wants.
 */
export function createJsonLogger(
  level: LogLevel,
  write: (line: string) => void,
  { bare = false }: { bare?: boolean } = {},
): Logger {
  const destination: DestinationStream = { write: (line) => write(fitRecord(line)) };
  const options = loggerOptions(level);
  return pino(bare ? { ...options, timestamp: false, base: undefined } : options, destination);
}

function loggerOptions(level: LogLevel): LoggerOptions {
  return {
    level,
    // `"level":"error"` rather than pino's `50`, and a time a person can read in raw output.
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Call sites log ids, never emails. This is the backstop that makes the rule hold without a
    // reviewer catching it. Not `to`: it is as often a state or a date as a recipient.
    redact: ['email', '*.email'],
    // An `Error` under a key with no serializer is written as `{}`, because `message` and `stack`
    // are not enumerable, and nothing fails. So every key an error rides under gets one. New code
    // uses `err`, which is where `log.error(error, '…')` puts it.
    serializers: Object.fromEntries(ERROR_KEYS.map((key) => [key, serializeError])),
  };
}

/** `pino-pretty` is a dev dependency, absent from the images, so it loads only when asked for.
 *
 * `createRequire` rather than `import()` keeps `createLogger` synchronous.
 */
function loadPrettyStream(): DestinationStream {
  const require = createRequire(import.meta.url);
  let pretty: (options: { sync: boolean }) => DestinationStream;
  try {
    pretty = require('pino-pretty');
  } catch (error) {
    throw new Error(
      "LOG_FORMAT=pretty needs pino-pretty, a dev dependency of @gbd/core that isn't installed " +
        'here. It is for local development; unset LOG_FORMAT for JSON.',
      { cause: error },
    );
  }
  return pretty({ sync: true });
}

// -----------------------------------------------------
// Record bound
// -----------------------------------------------------

/** No record written is longer than this, newline included.
 *
 * It is DigitalOcean's per-line forwarding cap, the tightest among the hosts
 * `.claude/plans/hosting-provider.md` compared. A line the forwarder splits is one no destination
 * can parse, so a looser host only raises this.
 */
export const MAX_RECORD_BYTES = 2_000;

/** Room kept for the `"truncated":[…]` field `fitRecord` adds. Names that do not fit are left off. */
const TRUNCATION_RESERVE_BYTES = 300;

/** Return `line`, or, when it is over `MAX_RECORD_BYTES`, the same record with its largest fields
 * dropped and named under `truncated`.
 *
 * The error serializer's trimming keeps ordinary records under the bound; this is what makes the
 * bound hold for the rest, such as a call site that logs a large object.
 */
function fitRecord(line: string): string {
  if (Buffer.byteLength(line) <= MAX_RECORD_BYTES) return line;

  const record: Record<string, unknown> = JSON.parse(line);
  const entries = Object.entries(record).map(([key, value]) => ({
    key,
    value,
    // Each counted with a trailing comma, which covers the one before `truncated`.
    bytes: Buffer.byteLength(`${JSON.stringify(key)}:${JSON.stringify(value)},`),
  }));
  // Errors first: a record that lost its error has lost its point, and the serializer keeps each
  // under `ERROR_BYTES`. Then smallest first, so `level`, `time`, the ids and a short `msg` survive.
  const byPriority = entries.toSorted(
    (a, b) =>
      Number(ERROR_KEYS.includes(b.key)) - Number(ERROR_KEYS.includes(a.key)) || a.bytes - b.bytes,
  );
  const kept = new Set(
    fitWithin(
      byPriority,
      MAX_RECORD_BYTES - TRUNCATION_RESERVE_BYTES - '{}\n'.length,
      (entry) => entry.bytes,
    ),
  );

  const fitted = Object.fromEntries(
    entries.filter((entry) => kept.has(entry)).map(({ key, value }) => [key, value]),
  );
  const dropped = entries.filter((entry) => !kept.has(entry)).map((entry) => entry.key);
  const truncated = fitWithin(dropped, TRUNCATION_RESERVE_BYTES - '"truncated":[]'.length, (key) =>
    Buffer.byteLength(`${JSON.stringify(key)},`),
  );
  return `${JSON.stringify({ ...fitted, truncated })}\n`;
}

/** The items, in order, that fit in `budget`, skipping any that would overrun it. */
function fitWithin<T>(items: readonly T[], budget: number, bytesOf: (item: T) => number): T[] {
  let used = 0;
  return items.filter((item) => {
    const bytes = bytesOf(item);
    if (used + bytes > budget) return false;
    used += bytes;
    return true;
  });
}

// -----------------------------------------------------
// Errors
// -----------------------------------------------------

/** The most one serialized error may take, leaving the rest of its record room for ids and `msg`. */
const ERROR_BYTES = 1_400;
/** Stack bytes for the logged error. Each level of cause gets half its parent's, split among
 * siblings, so a whole chain's stacks stay under twice this. */
const STACK_BYTES = 700;
/** Below this, a stack could not hold a frame, so it is left out. */
const MIN_STACK_BYTES = 80;
/** For the message, and for each other field an error carries. */
const FIELD_BYTES = 300;
/** The smallest fraction of the budgets above that `serializeScaled` tries. A message cut shorter
 * than an eighth would no longer say what went wrong. */
const MIN_SCALE = 1 / 8;
/** How many levels of cause are followed. Also what ends a cycle. */
const MAX_ERROR_DEPTH = 4;
const MAX_AGGREGATE_ERRORS = 3;

/** `pg`'s `DatabaseError` fields that carry row values or SQL text. `detail` is where Postgres
 * writes "Key (email)=(…) already exists". `code`, `constraint`, `table` and `column` stay: they
 * identify a violation without its data. */
const DROPPED_ERROR_FIELDS = new Set(['detail', 'internalQuery', 'where']);
/** Written from the error itself, so an enumerable field of the same name must not override. */
const OWN_ERROR_FIELDS = new Set(['type', 'message', 'stack', 'cause', 'aggregateErrors']);

type ErrorLike = Error & { readonly errors?: unknown };

type ErrorBudget = { readonly stackBytes: number; readonly fieldBytes: number };

function isErrorLike(value: unknown): value is ErrorLike {
  return value instanceof Error;
}

/** pino's `errWithCause`, but trimmed to fit a record, and without `pg`'s data-bearing fields. */
function serializeError(value: unknown): unknown {
  return isErrorLike(value) ? serializeScaled(value, 1) : value;
}

/** A chain of long messages overruns `ERROR_BYTES` at full budgets, and `fitRecord` would then drop
 * the error whole. Halving every budget until it fits keeps each message and the top of each stack.
 */
function serializeScaled(error: ErrorLike, scale: number): Record<string, unknown> {
  const budget = {
    stackBytes: Math.floor(STACK_BYTES * scale),
    fieldBytes: Math.floor(FIELD_BYTES * scale),
  };
  const serialized = serializeErrorWithin(error, budget, 0);
  if (jsonBytes(serialized) <= ERROR_BYTES || scale <= MIN_SCALE) return serialized;
  return serializeScaled(error, scale / 2);
}

function serializeErrorWithin(
  error: ErrorLike,
  budget: ErrorBudget,
  depth: number,
): Record<string, unknown> {
  const fields = Object.entries(error).filter(
    ([key]) => !DROPPED_ERROR_FIELDS.has(key) && !OWN_ERROR_FIELDS.has(key),
  );
  const nested = depth + 1 < MAX_ERROR_DEPTH;
  const cause = nested && isErrorLike(error.cause) ? error.cause : undefined;
  const aggregated =
    nested && Array.isArray(error.errors)
      ? error.errors.filter(isErrorLike).slice(0, MAX_AGGREGATE_ERRORS)
      : [];
  const errorFields = nested ? fields.filter(([, field]) => isErrorLike(field)).length : 0;

  const children = (cause ? 1 : 0) + aggregated.length + errorFields;
  const child = (inner: ErrorLike) =>
    serializeErrorWithin(
      inner,
      { ...budget, stackBytes: budget.stackBytes / 2 / children },
      depth + 1,
    );

  return {
    type: error.constructor.name,
    message: truncateBytes(error.message, budget.fieldBytes),
    ...(error.stack && budget.stackBytes >= MIN_STACK_BYTES
      ? { stack: trimStack(error.stack, budget.stackBytes) }
      : {}),
    ...Object.fromEntries(
      fields.flatMap(([key, field]) => {
        if (!isErrorLike(field)) return [[key, boundField(field, budget.fieldBytes)]];
        return nested ? [[key, child(field)]] : [];
      }),
    ),
    ...(cause ? { cause: child(cause) } : {}),
    ...(aggregated.length > 0 ? { aggregateErrors: aggregated.map(child) } : {}),
  };
}

/** A string is cut to `maxBytes`. Any other value that would overrun it, or that cannot be
 * serialized, is replaced by a note saying so. */
function boundField(value: unknown, maxBytes: number): unknown {
  if (typeof value === 'string') return truncateBytes(value, maxBytes);
  return jsonBytes(value) <= maxBytes ? value : `[${typeof value} omitted]`;
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '');
  } catch {
    // A cycle or a BigInt.
    return Number.POSITIVE_INFINITY;
  }
}

/** Keep the stack's leading lines that fit in `maxBytes`, and say how many were cut. */
function trimStack(stack: string, maxBytes: number): string {
  const [header = '', ...frames] = stack.split('\n');
  const kept = [truncateBytes(header, maxBytes)];
  let used = Buffer.byteLength(kept[0] ?? '');
  for (const frame of frames.map(shortenFramePath)) {
    used += Buffer.byteLength(frame) + 1;
    if (used > maxBytes) break;
    kept.push(frame);
  }
  const cut = frames.length - (kept.length - 1);
  return cut > 0 ? `${kept.join('\n')}\n    … ${cut} more` : kept.join('\n');
}

/** A frame's path, from the package for a dependency and from the working directory for our own
 * code. The absolute prefix is the same on every frame, and it would cost half the stack budget. */
function shortenFramePath(frame: string): string {
  const cwd = process.cwd();
  return frame
    .replace(/(?:file:\/\/)?[^\s(]*\/node_modules\//g, '')
    .replaceAll(`file://${cwd}/`, '')
    .replaceAll(`${cwd}/`, '');
}

function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  // A cut through a multi-byte character decodes as U+FFFD, which is dropped.
  return `${Buffer.from(text).subarray(0, maxBytes).toString().replace(/�+$/, '')}…`;
}
