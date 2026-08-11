import { S3Client } from '@aws-sdk/client-s3';

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
   * is sent and the store has processed it. So this is a cap on the slowest legitimate upload rather
   * than only a stall detector, and cutting it fails every attempt of an upload that would have
   * finished. REQUIREMENTS.md caps an upload at 10MB, which 30s carries down to 2.7Mbit/s; in-region
   * a real one is under a second.
   */
  attemptTimeoutMs: number;

  /** The wall clock one request gets, retries and backoff included.
   *
   * A count is a poor proxy for time, which is the whole reason this exists: `MAX_ATTEMPTS` against
   * a store that fails fast is 1.3s, but against one that accepts sockets and never answers it is
   * `MAX_ATTEMPTS × attemptTimeoutMs` — three minutes, with no route timeout above it to cut in.
   * 45s leaves fast failures untouched and turns that three minutes into about 47s.
   *
   * The SDK has no such setting; `sendOptions` enforces it with an `AbortSignal` spanning the retry
   * loop. That aborts an attempt in flight, but overshoots by up to ~2s, because a backoff sleep
   * carries on sleeping.
   *
   * ARCHITECTURE.md requires the worker's hang threshold to "exceed the longest valid API call
   * including backoff", so this number is a floor under that threshold: lower here means a hung
   * analysis is caught sooner.
   */
  requestDeadlineMs: number;
};

export const DEFAULT_LIMITS: BlobStoreLimits = {
  connectionTimeoutMs: 5_000,
  attemptTimeoutMs: 30_000,
  requestDeadlineMs: 45_000,
};

/** How many times to try a request the SDK considers retryable, the first attempt included.
 *
 * Every operation here is idempotent, so an extra attempt costs only the wait. Three of them span
 * under 300ms of backoff, too little to outlast the momentary 500 that failed a CI run. Going higher
 * than six buys little, since `requestDeadlineMs` is the real bound on waiting, and outlasting an
 * outage for longer than that is a user-initiated retry's job — see ARCHITECTURE.md.
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
 * enforced. A send without them inherits `maxAttempts` and no clock at all.
 */
export function sendOptions(store: BlobStore): { abortSignal: AbortSignal } {
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

    maxAttempts: MAX_ATTEMPTS,
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
