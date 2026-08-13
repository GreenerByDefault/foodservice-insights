# @gbd/storage

The blob store, reached through its S3 API. Used by both the web app and the worker parent.

For how the blob store fits into the wider system, and why it is Supabase Storage over S3 rather
than the Supabase JavaScript SDK, see [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## Using it

Every operation takes a `BlobStore` — a bucket plus a client that can reach it — as its first
parameter, so that callers stay testable. Build one with `initializeBlobStore`, or take whichever
your caller already has:

- **The web app** calls `blobStore()` from `$lib/server/storage`, which reads
  `$env/dynamic/private` on first use.
- **Everything outside Vite** imports `BLOB_STORE` from `@gbd/storage/env`, which reads the
  process environment. `TEST_DB=1` selects the test stack.
- **Helper functions** should take a `BlobStore` parameter rather than reaching for either, so a
  test can pass one and the app can pass its own.

A missing object is `undefined`, not an exception. Everything else that fails throws a
`BlobStoreError`, so a caller can tell the blob store failing apart from a bug of its own with
`isBlobStoreError`.

Unfortunately, a missing bucket reads as an empty store, rather than failing when reading a key, per
[`src/errors.ts`](src/errors.ts). Instead, you can use `bucketExists` to check the bucket itself.

The bucket has to exist before anything can be written to it. Tests create it themselves through
`globalSetup`; for the dev stack, `pnpm migrate` creates it alongside applying the database's
migrations.

## Storing this product's files

The bucket is private. Its key layout, and the rules that hold it together, live in
[`src/keys.ts`](src/keys.ts).

`putInputFile`, `putResultFile`, and `putRejectedUpload` write a file and return the metadata its
database row needs, so the object and the row cannot disagree. The caller writes the row itself,
inside its own transaction. Deleting an organization's files is one `deletePrefix` over
`organizationPrefix(id)`.

Tests use `withTemporaryOrganization` rather than `withTemporaryPrefix`, because real keys start at
`org/{id}/`.
