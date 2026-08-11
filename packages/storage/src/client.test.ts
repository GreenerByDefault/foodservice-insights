/** What the client does with a store that fails, against a local server standing in for one. */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import {
  type BlobStore,
  type BlobStoreLimits,
  initializeBlobStore,
  MAX_ATTEMPTS,
  shutdownBlobStore,
} from './client.ts';
import { putObject } from './objects.ts';

let server: Server | undefined;
let store: BlobStore | undefined;

afterEach(async () => {
  if (store) shutdownBlobStore(store);
  if (server) await new Promise((resolve) => server?.close(resolve));
  server = undefined;
  store = undefined;
});

/** How the stand-in store misbehaves. */
type Failure =
  /** Answers every request the way a momentarily unhealthy Supabase Storage does. */
  | 'fails fast'
  /** Accepts the socket and never answers, which is what a hang looks like from here. */
  | 'never answers';

async function failingStore(
  failure: Failure,
  limits?: Partial<BlobStoreLimits>,
): Promise<{ store: BlobStore; attempts: () => number }> {
  let attempts = 0;

  server = createServer((_request, response) => {
    attempts++;
    if (failure === 'never answers') return;

    response.writeHead(500, { 'Content-Type': 'application/xml' });
    response.end(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Error><Code>InternalError</Code><Message>Internal Server Error</Message></Error>',
    );
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  store = initializeBlobStore({
    endpoint: `http://127.0.0.1:${port}/storage/v1/s3`,
    region: 'local',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    bucket: 'files',
    limits,
  });

  return { store, attempts: () => attempts };
}

// Counting attempts is the only way to notice the budget being narrowed back to the SDK's default
// of three, which is the flake this guards against.
test('keeps trying a write the store answers with a 500', async () => {
  const { store: failing, attempts } = await failingStore('fails fast');

  await expect(putObject(failing, 'probe.bin', new Uint8Array([1, 2, 3]))).rejects.toThrow(
    'Internal Server Error',
  );

  expect(attempts()).toBe(MAX_ATTEMPTS);
});

// Limits a hundredth of the real ones, so the test is quick; only their ratio matters here. What
// the real ones would cost, and why, is on `requestDeadlineMs`.
test('gives up on a store that never answers once the deadline passes', async () => {
  const attemptTimeoutMs = 5_000;
  const { store: hanging, attempts } = await failingStore('never answers', {
    attemptTimeoutMs,
    requestDeadlineMs: 300,
  });

  const started = Date.now();
  await expect(putObject(hanging, 'probe.bin', new Uint8Array([1, 2, 3]))).rejects.toThrow(
    /aborted/i,
  );
  const elapsed = Date.now() - started;

  // Well short of even one attempt timing out, so the deadline is what ended it. The slack is for
  // the overshoot of an abort that cannot interrupt a backoff sleep.
  expect(elapsed).toBeLessThan(attemptTimeoutMs);
  expect(attempts()).toBeLessThan(MAX_ATTEMPTS);
});
