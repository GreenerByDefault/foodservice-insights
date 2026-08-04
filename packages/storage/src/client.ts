import { S3Client } from '@aws-sdk/client-s3';

/** How long to wait for a connection to open. */
const CONNECTION_TIMEOUT_MS = 5_000;

/** How long to wait for a whole request to finish. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How many times to try a request the SDK considers retryable, the first attempt included. */
const MAX_ATTEMPTS = 3;

export type BlobStoreConfig = {
  /** The S3 API endpoint. For Supabase, this ends in `/storage/v1/s3`. */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
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
};

/** Build a blob store handle over its own HTTP connection pool.
 *
 * Every caller owns the returned handle for its whole lifetime and must pass it to
 * `shutdownBlobStore` on the way out. This connects to nothing —
 * an S3 client only opens sockets when a request is actually made.
 */
export function initializeBlobStore(config: BlobStoreConfig): BlobStore {
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
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
    },
  });

  return { client, bucket: config.bucket };
}

/** Release the sockets a blob store is holding.
 *
 * Synchronous because `destroy()` itself is.
 */
export function shutdownBlobStore(store: BlobStore): void {
  store.client.destroy();
}
