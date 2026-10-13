// Temporary: part of the one-time go-live import of GBD's cache CSVs
// (.claude/plans/caches-to-supabase.md). This directory is deleted once that import is checked.
//
// Which database the import writes to. Deliberately not `src/env.ts`'s `DATABASE`, which every
// other script shares: there, whatever `DB_CONNECTION_STRING` holds is the target, and a run
// against production looks exactly like a run against a laptop. Here the two are different paths:
//
// - Local, the default: `DB_CONNECTION_STRING` from `.env` (or `.env.test` with `TEST_DB=1`), as
//   for `migrate`, and refused unless it points at this machine. A production string put in
//   `.env` by mistake therefore cannot be written to by forgetting a flag.
// - `--production`: never reads `.env` or the environment. It needs a person at a terminal, who
//   pastes the connection string into a prompt that does not echo it, so the `postgres` password
//   lands in neither `.env` nor shell history, and an agent or a pipe cannot run it at all.

import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { loadLocalEnv, requireEnv } from '@gbd/core/env';

export type Target = 'local' | 'production';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export async function connectionStringFor(target: Target): Promise<string> {
  if (target === 'local') {
    loadLocalEnv();
    const connectionString = requireEnv('DB_CONNECTION_STRING');
    throwIfWrongTarget('local', connectionString);
    return connectionString;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('--production must be run by a person in a terminal: it prompts for input');
  }
  const connectionString = await ask(
    "Production connection string (the Connect dialog's direct connection, as postgres): ",
    { echo: false },
  );
  throwIfWrongTarget('production', connectionString);
  return connectionString;
}

/** Throws unless a connection string's host is loopback exactly when `target` is local. */
export function throwIfWrongTarget(target: Target, connectionString: string): void {
  const { hostname } = parseConnectionString(connectionString);
  const isLoopback = LOOPBACK_HOSTS.has(hostname);
  if (target === 'local' && !isLoopback) {
    throw new Error(
      `DB_CONNECTION_STRING points at ${hostname}, not this machine. Without --production, ` +
        'this script only writes to a local database.',
    );
  }
  if (target === 'production' && isLoopback) {
    throw new Error(`That connection string points at ${hostname}, this machine, not production`);
  }
}

/** `user@host:port/database`, without the password. */
export function describeConnectionString(connectionString: string): string {
  const url = parseConnectionString(connectionString);
  return `${decodeURIComponent(url.username)}@${url.host}${url.pathname}`;
}

function parseConnectionString(connectionString: string): URL {
  const url = URL.parse(connectionString.trim());
  if (url === null || !['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('Expected a postgresql:// connection string');
  }
  return url;
}

/** Ask a question at the terminal. With `echo: false`, what is typed or pasted is not shown. */
export async function ask(question: string, { echo = true } = {}): Promise<string> {
  process.stdout.write(question);
  // readline echoes input to its output stream, so a silenced stream hides it.
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (echo) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const readline = createInterface({ input: process.stdin, output, terminal: true });
  // In raw mode, Ctrl-C reaches readline rather than the process.
  readline.on('SIGINT', () => process.exit(130));
  try {
    return (await readline.question('')).trim();
  } finally {
    readline.close();
    if (!echo) process.stdout.write('\n');
  }
}
