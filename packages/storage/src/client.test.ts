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
import { isBlobStoreError } from './errors.ts';
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
// of three, and elapsed time the only way to notice the backoff schedule being dropped for the
// SDK's default jitter — each is a flake this guards against.
test('keeps trying a write the store answers with a 500, waiting between tries', async () => {
  const retryDelayBaseMs = 10;
  const { store: failing, attempts } = await failingStore('fails fast', { retryDelayBaseMs });

  const started = Date.now();
  const thrown = await putObject(failing, 'probe.bin', new Uint8Array([1, 2, 3])).catch(
    (error: unknown) => error,
  );
  const elapsed = Date.now() - started;

  // `putObject` relabels every failure as a `BlobStoreError`; the SDK's own message survives on
  // `cause`, which is where this asserts against it.
  if (!isBlobStoreError(thrown)) throw thrown;
  expect(thrown.cause).toMatchObject({
    message: expect.stringContaining('Internal Server Error'),
  });
  expect(attempts()).toBe(MAX_ATTEMPTS);

  // The five retries double from the base: 10+20+40+80+160ms. Elapsed only has a lower bound —
  // an upper one would flake on a slow runner.
  expect(elapsed).toBeGreaterThanOrEqual(31 * retryDelayBaseMs);

  // `$metadata` (status code, attempts) survives on the cause; `$response` must not — it drags
  // the whole HTTP exchange into whatever serializes the error.
  expect(thrown.cause).toHaveProperty('$metadata');
  expect(thrown.cause).not.toHaveProperty('$response');
});

// Limits are much shorter than the real ones, so the test is quick; only their ratio matters
// here. `retryDelayBaseMs` has to shrink with them: an aborted attempt still gets retried, and
// the deadline cannot interrupt a backoff sleep, so real-sized sleeps would dominate `elapsed`.
test('gives up on a store that never answers once the deadline passes', async () => {
  const attemptTimeoutMs = 5_000;
  const { store: hanging, attempts } = await failingStore('never answers', {
    attemptTimeoutMs,
    retryDelayBaseMs: 1,
    requestDeadlineMs: 300,
  });

  const started = Date.now();
  await expect(putObject(hanging, 'probe.bin', new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
    name: 'BlobStoreError',
    cause: expect.objectContaining({ message: expect.stringMatching(/aborted/i) }),
  });
  const elapsed = Date.now() - started;

  // Well short of even one attempt timing out, so the deadline is what ended it. The slack is for
  // the overshoot of an abort that cannot interrupt a backoff sleep.
  expect(elapsed).toBeLessThan(attemptTimeoutMs);
  expect(attempts()).toBeLessThan(MAX_ATTEMPTS);
});
