import { S3Client } from '@aws-sdk/client-s3';
import { ConfiguredRetryStrategy } from '@smithy/core/retry';

/** The time limits on reaching the store. Each bounds *one request*, so a function that pages, like
 * `deletePrefix`, takes as long as its data needs.
 */
export type BlobStoreLimits = {
  /** How long to wait for a connection to open. Both ends being us-east, a TCP and TLS handshake is
   * single-digit milliseconds, so this is only reached when the network blackholes rather than
   * refuses.
   */
  connectionTimeoutMs: number;

  /** How long one attempt may take.
   *
   * The clock is reset only by bytes arriving *back*, and a write gets nothing back until the body
   * is sent and the store has processed it. So, this is a cap on the slowest legitimate upload rather
   * than only a stall detector, and cutting it fails every attempt of an upload that would have
   * finished. `MAX_UPLOAD_BYTES` caps an upload at 10MB, which 30s carries down to 2.7Mbit/s; in-region,
   * a real upload should be under a second.
   */
  attemptTimeoutMs: number;

  /** The wait before the first retry; each later retry doubles it (500ms → 1s → 2s → 4s → 8s).
   *
   * Passed to the SDK in place of its default backoff, which draws each delay at random from
   * under `100ms × 2^attempt` — so all of `MAX_ATTEMPTS` land inside ~3 seconds. A CI flake
   * showed Supabase Storage answering 500 for longer than that, failing every attempt while
   * `requestDeadlineMs` still had 42s to give. Retries have to spread over time, not just
   * count: doubling deterministically from this base waits 31× the base in total.
   */
  retryDelayBaseMs: number;

  /** The wall clock one request gets, retries and backoff included.
   *
   * This is a failsafe under `MAX_ATTEMPTS`: a count is a poor proxy for time. Against a store
   * that fails fast, `MAX_ATTEMPTS` retries wait out the backoff schedule (see `retryDelayBaseMs`),
   * but against one that accepts sockets and never answers, they take
   * `MAX_ATTEMPTS × attemptTimeoutMs` — three minutes, with no route timeout above it to cut in.
   * 45s leaves faster failures untouched and turns that three minutes into about 47s.
   *
   * Lower here catches a hung upload sooner. Enforcement can overshoot this by up to the
   * longest backoff sleep — see `sendOptions`.
   */
  requestDeadlineMs: number;
};

export const DEFAULT_LIMITS: BlobStoreLimits = {
  connectionTimeoutMs: 5_000,
  attemptTimeoutMs: 30_000,
  retryDelayBaseMs: 500,
  requestDeadlineMs: 45_000,
};

/** How many times to try a request the SDK considers retryable, the first attempt included.
 *
 * Every operation here is idempotent, so an extra attempt costs only the wait. Going higher
 * than six buys little, since `requestDeadlineMs` is the real bound on waiting. If an outage
 * lasts longer than that, a user will need to initiate a retry on their analysis.
 */
export const MAX_ATTEMPTS = 6;

export type BlobStoreConfig = {
  /** The S3 API endpoint. For Supabase, this ends in `/storage/v1/s3`. */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  limits?: Partial<BlobStoreLimits>;
};

/** A bucket, plus a client that can reach it.
 *
 * Every function in this package takes BlobStore as its first parameter so that callers are
 * testable: the app passes its long-lived store, and tests pass one scoped to a throwaway
 * prefix.
 */
export type BlobStore = {
  readonly client: S3Client;
  readonly bucket: string;

  /** Carried on the handle because a deadline can only be set per send — see `sendOptions`. */
  readonly requestDeadlineMs: number;
};

/** The options every `client.send` in this package passes, which is how `requestDeadlineMs` is
 * enforced.
 *
 * The SDK has no setting for a deadline spanning retries, so this builds one from an
 * `AbortSignal` instead.
 */
export function sendOptions(store: BlobStore): { abortSignal: AbortSignal } {
  // Aborts an attempt in flight, but a backoff sleep carries on sleeping — the SDK's cooldown
  // ignores the signal — so this overshoots by up to the longest remaining sleep, 8s at the
  // default `retryDelayBaseMs`.
  return { abortSignal: AbortSignal.timeout(store.requestDeadlineMs) };
}

/** Build a blob store handle over its own HTTP connection pool.
 *
 * Every caller owns the returned handle for its whole lifetime and must pass it to
 * `shutdownBlobStore` on the way out. This connects to nothing —
 * an S3 client only opens sockets when a request is actually made.
 */
export function initializeBlobStore(config: BlobStoreConfig): BlobStore {
  const limits = { ...DEFAULT_LIMITS, ...config.limits };

  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,

    // Supabase Storage puts the bucket in the request path. Left false, the SDK would put it
    // in the hostname instead — `bucket.127.0.0.1` — which resolves nowhere.
    forcePathStyle: true,

    // Credentials are always passed explicitly, never left to the SDK's default credential chain.
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },

    // The strategy is what enforces the attempt count; `maxAttempts` is repeated because it is
    // what stamps the `amz-sdk-request: attempt=n; max=m` header the strategy does not control.
    maxAttempts: MAX_ATTEMPTS,
    retryStrategy: new ConfiguredRetryStrategy(
      MAX_ATTEMPTS,
      (attempt: number) => limits.retryDelayBaseMs * 2 ** (attempt - 1),
    ),

    requestHandler: {
      connectionTimeout: limits.connectionTimeoutMs,
      requestTimeout: limits.attemptTimeoutMs,

      // Without this, the SDK treats `requestTimeout` as advisory.
      // With this set, the client throws TimeoutError. TimeoutError
      // is handled by maxAttempts.
      throwOnRequestTimeout: true,
    },
  });

  return { client, bucket: config.bucket, requestDeadlineMs: limits.requestDeadlineMs };
}

/** Release the sockets a blob store is holding.
 *
 * Synchronous because `destroy()` itself is.
 */
export function shutdownBlobStore(store: BlobStore): void {
  store.client.destroy();
}
