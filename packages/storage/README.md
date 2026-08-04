# @gbd/storage

The blob store, reached through its S3 API. Used by both the web app and the worker parent.

> **Status: the key layout below is still a spec.** The code here is generic — a client, and the
> few operations the setup itself needs. Nothing in it builds or knows the keys described under
> [Key layout](#key-layout). Delete that section once the code that constructs those keys lands,
> and let the code carry the detail.

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

## Key layout

The bucket is private.

```
org/{org_id}
    /rejected-upload/{rejected_upload_id}.csv
    /report/{report_id}
        /input/{input_file_id}.csv
        /analysis_attempt/{analysis_attempt_id}
            /result/{result_file_id}.{ext}
```

Keying everything under `org/{org_id}` means deleting an organization's files is a single
`deletePrefix`.
