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

A missing object is `undefined`, not an exception. A missing *bucket* still throws, because that
is a misconfiguration rather than an expected outcome.

The bucket has to exist before anything can be written to it. Tests create it themselves through
`globalSetup`; for the dev stack, `pnpm migrate` creates it alongside applying the database's
migrations.

## Storing this product's files

The bucket is private, and its key layout lives in [`src/keys.ts`](src/keys.ts).

`putInputFile`, `putResultFile`, and `putRejectedUpload` are how a file gets written. Each builds
its own key and returns the metadata its database row needs, so the object and the row cannot
disagree; the caller writes the row, inside its own transaction. Nothing reads a file by rebuilding
its key — every reader takes `storage_key` off the row.

Everything an organization owns lives under `organizationPrefix(id)`, so deleting an organization's
files is one `deletePrefix`.

This is why a blob store package depends on `@gbd/db`: keys are made of row ids, and taking them
branded is what stops a report id being written where a file id belongs. The dependency is
type-only, and should stay that way — wanting a *runtime* import from `@gbd/db` here would be the
signal to split these two files into their own package rather than to widen this.

Tests that exercise any of this wrap their work in `withTemporaryOrganization` rather than
`withTemporaryPrefix`, because real keys start at `org/{id}/` rather than wherever a test would
prefer.
