import { Buffer } from 'node:buffer';
import { describe, expect, test } from 'vitest';
import {
  createJsonLogger,
  createLogger,
  type LogFormat,
  type LogLevel,
  MAX_RECORD_BYTES,
  parseLogSettings,
} from './log.ts';
import { collectingLogger } from './testing.ts';

describe('parseLogSettings', () => {
  test('unset or empty means info and json', () => {
    const expected = { level: 'info', format: 'json' };
    expect(parseLogSettings({ level: undefined, format: undefined })).toEqual(expected);
    expect(parseLogSettings({ level: '', format: '' })).toEqual(expected);
  });

  test.each<LogLevel>(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])(
    'accepts LOG_LEVEL=%s',
    (level) => {
      expect(parseLogSettings({ level, format: undefined })).toEqual({ level, format: 'json' });
    },
  );

  test.each<LogFormat>(['json', 'pretty'])('accepts LOG_FORMAT=%s', (format) => {
    expect(parseLogSettings({ level: undefined, format })).toEqual({ level: 'info', format });
  });

  test('an unknown value throws, naming the variable', () => {
    expect(() => parseLogSettings({ level: 'verbose', format: undefined })).toThrow(
      "Unknown LOG_LEVEL 'verbose'. Expected one of: fatal, error, warn, info, debug, trace, silent.",
    );
    expect(() => parseLogSettings({ level: undefined, format: 'text' })).toThrow(
      "Unknown LOG_FORMAT 'text'. Expected one of: json, pretty.",
    );
  });
});

describe('createLogger', () => {
  test('pretty constructs', () => {
    expect(createLogger({ level: 'silent', format: 'pretty' }).level).toBe('silent');
  });
});

describe('createJsonLogger', () => {
  test('writes the level by name and the time as an ISO string', () => {
    const lines: string[] = [];
    createJsonLogger('info', (line) => lines.push(line)).info({ userId: 'u1' }, 'hello');

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        level: 'info',
        time: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
        pid: process.pid,
        hostname: expect.any(String),
        userId: 'u1',
        msg: 'hello',
      },
    ]);
  });

  test('drops the largest fields of a record over the bound, and names them', () => {
    const lines: string[] = [];
    const log = createJsonLogger('info', (line) => lines.push(line), { bare: true });

    log.info({ blob: 'x'.repeat(MAX_RECORD_BYTES), userId: 'u1' }, 'big');

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { level: 'info', userId: 'u1', msg: 'big', truncated: ['blob'] },
    ]);
  });
});

describe('collectingLogger', () => {
  test('keeps every level, with child bindings, until cleared', () => {
    const sink = collectingLogger();

    sink.log.child({ attemptId: 'a1' }).debug('polled');
    expect(sink.records).toEqual([{ level: 'debug', attemptId: 'a1', msg: 'polled' }]);

    sink.clear();
    expect(sink.records).toEqual([]);
  });

  test('redacts email and to, top-level and one deep', () => {
    const sink = collectingLogger();

    sink.log.info({
      email: 'a@example.com',
      to: 'b@example.com',
      user: { email: 'c@example.com' },
    });

    expect(sink.records).toEqual([
      { level: 'info', email: '[Redacted]', to: '[Redacted]', user: { email: '[Redacted]' } },
    ]);
  });
});

describe('error serializer', () => {
  test.each(['err', 'error', 'cause'])('serializes an error under %s', (key) => {
    const sink = collectingLogger();

    sink.log.error({ [key]: new Error('boom') }, 'failed');

    expect(sink.records).toEqual([
      {
        level: 'error',
        [key]: { type: 'Error', message: 'boom', stack: expect.stringMatching(/^Error: boom\n/) },
        msg: 'failed',
      },
    ]);
  });

  test('an error passed first lands under err', () => {
    const sink = collectingLogger();

    sink.log.error(new TypeError('boom'), 'failed');

    expect(sink.records).toEqual([
      {
        level: 'error',
        err: { type: 'TypeError', message: 'boom', stack: expect.any(String) },
        msg: 'failed',
      },
    ]);
  });

  function deepError(message: string, frames: number, cause?: Error): Error {
    return frames === 0 ? new Error(message, { cause }) : deepError(message, frames - 1, cause);
  }

  test('a three-deep cause chain stays within the bound, keeping every message', () => {
    const lines: string[] = [];
    const log = createJsonLogger('error', (line) => lines.push(line));
    // Past the default limit of 10 frames, so each untrimmed stack is over the bound on its own.
    const { stackTraceLimit } = Error;
    Error.stackTraceLimit = 100;
    const error = deepError('outer', 50, deepError('middle', 50, deepError('inner', 50)));
    Error.stackTraceLimit = stackTraceLimit;
    expect(Buffer.byteLength(error.stack ?? '')).toBeGreaterThan(MAX_RECORD_BYTES);

    log.error(error, 'failed');

    const [line = ''] = lines;
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    const { err } = JSON.parse(line);
    expect(err).not.toHaveProperty('truncated');
    expect([err.message, err.cause.message, err.cause.cause.message]).toEqual([
      'outer',
      'middle',
      'inner',
    ]);
    for (const trimmed of [err.stack, err.cause.stack, err.cause.cause.stack]) {
      expect(trimmed).toMatch(/\n {4}… \d+ more$/);
    }
  });

  test('a cycle of causes ends after four levels', () => {
    const sink = collectingLogger();
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    first.cause = second;

    sink.log.error(first, 'failed');

    const messages = (error: { message: string; cause?: unknown } | undefined): string[] =>
      error ? [error.message, ...messages(error.cause as typeof error)] : [];
    expect(messages(sink.records[0]?.err as { message: string })).toEqual([
      'first',
      'second',
      'first',
      'second',
    ]);
  });

  test("an aggregate's errors are kept, up to three", () => {
    const sink = collectingLogger();
    const refused = (address: string) =>
      Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: 'ECONNREFUSED' });

    sink.log.error(
      new AggregateError(['::1', '127.0.0.1', 'a', 'b'].map(refused), 'All attempts failed'),
    );

    const [record] = sink.records;
    expect(record?.err).toEqual({
      type: 'AggregateError',
      message: 'All attempts failed',
      stack: expect.any(String),
      aggregateErrors: ['::1', '127.0.0.1', 'a'].map((address) => ({
        type: 'Error',
        message: `connect ECONNREFUSED ${address}`,
        stack: expect.any(String),
        code: 'ECONNREFUSED',
      })),
    });
  });

  test('a long message is cut', () => {
    const sink = collectingLogger();

    sink.log.error(new Error('é'.repeat(1_000)));

    expect(sink.records[0]?.err).toEqual({
      type: 'Error',
      message: `${'é'.repeat(150)}…`,
      stack: expect.any(String),
    });
  });

  // A plain `Error` stands in for `pg`'s `DatabaseError`, which core cannot import.
  test("drops pg's row values and SQL text, keeping what identifies the violation", () => {
    const sink = collectingLogger();
    const error = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'app_user_email_key',
      table: 'app_user',
      column: 'email',
      detail: 'Key (email)=(a@example.com) already exists.',
      internalQuery: 'select 1',
      where: 'SQL statement "insert into app_user …"',
    });

    sink.log.error(error, 'failed');

    expect(sink.records[0]?.err).toEqual({
      type: 'Error',
      message: 'duplicate key value violates unique constraint',
      stack: expect.any(String),
      code: '23505',
      constraint: 'app_user_email_key',
      table: 'app_user',
      column: 'email',
    });
  });
});
