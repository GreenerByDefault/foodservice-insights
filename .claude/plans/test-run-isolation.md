# Isolate concurrent test runs

## Context

Several Claude Code sessions run at once on this machine — sometimes in different worktrees,
sometimes two in the same worktree. Every one of them resolves to the same test stack, because
`.env.test` hardcodes `DB_CONNECTION_STRING=…@127.0.0.1:65322/postgres` and the Supabase CLI keys
its containers on `project_id = "fsi-test"`, which is identical in every worktree's
`supabase-test/`.

The Playwright `webServer` command then does this on every run:

```
pnpm -r run truncate && pnpm -r run migrate && pnpm -r run seed:identity && node start.js
```

`pnpm -r run truncate` empties 32 Postgres tables, the blob store, and the mailbox — for
*everyone*. This reproduces deterministically: start
`test:e2e` in one worktree, run the truncate from another the moment the first test reports, and
nine specs fail on `Identified user 00000000-…-000000000001 has no row in the database`. That is
the whole flake, and it costs enough that sessions get stopped to run one at a time.

**The goal: any number of `pnpm test` runs, in any number of worktrees or sessions, never touch
each other's state.** A breaking schema change from another session is explicitly out of scope.

Two things this investigation established that change the shape of the fix:

1. **The vitest tiers are already correct and are not part of the problem.** `packages/db`,
   `storage`, `email`, `apps/worker` and `apps/web`'s `server` project all isolate per test —
   `withRollback`, randomised ids and emails, `withTemporaryPrefix`, unique mailbox recipients —
   and their global-setups deliberately never truncate, saying so in comments
   ([global-setup.ts](packages/db/src/testing/global-setup.ts)). They were victims of the
   Playwright truncate, not a second cause. **Nothing in this plan changes them.**

2. **Per-run *data* cannot work in one database, because of screenshots.** `auth.users` has a
   global unique index on `email` (`users_email_partial_key`), and two fixed emails are baked into
   committed PNGs: `phase-one@example.test` renders in the banner of every `fullPage` shot
   ([+layout.svelte:43](apps/web/src/routes/(app)/+layout.svelte#L43)) and `jordan@example.test`
   renders in `reports-failed.png` via the heading's email-fallback branch
   ([reports.ts](apps/web/e2e/fixtures/reports.ts)). Two concurrent runs cannot both own those
   emails. Giving each run its own **database** sidesteps this entirely: the placeholder identity,
   the fixtures, the specs and every committed PNG stay exactly as they are.

## What is actually shared, and what each becomes

| Shared today | Holds per-run state? | Fix |
| --- | --- | --- |
| Postgres db `postgres` @ 65322 | yes | a database per run, cloned from a cached template |
| Blob bucket `files` | yes | a bucket per run, `files-<runId>` |
| Mailpit @ 65324 | yes, but e2e never reads it | nothing — just stop calling `clearMailbox` |
| App server on port 4173, `reuseExistingServer: true` | yes (bound to one db at boot) | a free port per run, no reuse |
| `WORKER_RUN_ROOT` | not reached by the web e2e tier | nothing |

The `reuseExistingServer` line is worth calling out on its own: today a run in worktree B silently
reuses a server *built from worktree A's code* if one is listening on 4173, and skips the
truncate/migrate/seed chain while doing it. That is a correctness bug independent of the flake, and
a per-run port removes it.

## Design

### A database per run

Verified facts this rests on:

- `CREATE DATABASE x TEMPLATE postgres` is impossible — Supabase's own services hold permanent
  connections to `postgres`. So the template must be a database nothing connects to.
- Our migrations assume `auth.users` exists ([001_initial_schema.ts:82,124](packages/db/migrations/001_initial_schema.ts#L82))
  — GoTrue creates it, we do not.
- `supabase db dump --local --schema auth` produces **1,443 self-contained lines**: one
  `CREATE SCHEMA IF NOT EXISTS "auth"`, zero references to `extensions`/`vault`/`storage`/
  `graphql`, and grants only to cluster-wide roles (`anon`, `authenticated`, `supabase_auth_admin`,
  …). It restores into a database created from `template0` without pulling in the rest of Supabase.
- `uuidv7()` is created by our own migration and needs no extension.
- Node's `--env-file` and `process.loadEnvFile` both let the **environment win over the file**
  (verified empirically), so overriding `DB_CONNECTION_STRING` in the environment beats
  `.env.test` for both the wrapper's children and `start.js`.

#### Why `auth` is the only schema we dump

The test stack's `postgres` database has 11 non-system schemas — `storage`, `realtime`, `vault`,
`graphql`, `net`, `supabase_functions` and the rest. We use Supabase Storage heavily, so the
instinct that we need its schema too is the right instinct; it just does not survive contact with
the code. **We never reach `storage` over SQL — only over its S3 HTTP API.** The evidence:

- The Kysely `Database` type is `PublicSchema & AuthSchema`, nothing else
  ([generated/Database.ts](packages/db/src/generated/Database.ts)), and kanel is configured with
  `schemas: ['public', 'auth']` ([kanel.config.cjs](packages/db/kanel.config.cjs)). A query against
  a `storage.*` table would not typecheck.
- Grepping every `.ts` in `packages/` and `apps/` for schema-qualified references to `storage`,
  `realtime`, `vault`, `graphql`, `net`, `supabase_functions` or `extensions` returns nothing, and
  the only `withSchema()` call in the repo is a deliberately-invalid `'no_such_schema'` in a worker
  test.
- `packages/storage` talks to `@aws-sdk/client-s3` against `S3_ENDPOINT`
  ([storage/src/env.ts](packages/storage/src/env.ts)). `storage.buckets` and `storage.objects` are
  the storage-api *service's* private bookkeeping, and that service is a separate container wired to
  `postgres` by the Supabase CLI — not something our connection string points at.

That is also why the blob-store fix is a per-run **bucket** rather than a per-run schema: buckets
live in the stack's one storage service, shared by every run's database, so the isolation has to
happen at the bucket name.

This is an assumption the implementation must *prove*, not assume: a missing schema surfaces as a
loud `relation "…" does not exist`, never as a silent wrong answer, so PR 1's acceptance is the
full Playwright suite passing against a cloned database. If anything does turn out to need
`storage`, the fix is to add `--schema storage` to the dump, and the fingerprint picks the change up
automatically.

So:

```
pnpm test:playwright
  └─ apps/web/scripts/test-run.ts          (the wrapper)
       sweep stale fsi_test_run_* databases and files-* buckets
       ensure fsi_test_tmpl_<fingerprint>  (advisory-locked, built once)
       CREATE DATABASE fsi_test_run_<ts>_<rand> TEMPLATE fsi_test_tmpl_<fingerprint>
       seedPlaceholderIdentity(runDb)
       create bucket files-<runId>
       pick a free port
       env: DB_CONNECTION_STRING, S3_BUCKET, SITE_URL, PLAYWRIGHT_PORT, TEST_RUN_ID
       → spawn `playwright test …` with stdio inherited
       finally: DROP DATABASE … WITH (FORCE), empty + delete the bucket
```

**Template**, named `fsi_test_tmpl_<first 12 hex of sha256>` over the bytes of
`packages/db/auth-schema.sql` plus every file in `packages/db/migrations/`. The name *is* the cache
key, so existence is the only check needed — and a worktree on a branch with a different migration
set automatically gets a different template, which incidentally removes the out-of-scope
cross-branch-schema hazard for the Playwright tier. Building it: take `pg_advisory_lock` on a
maintenance connection to `postgres`, re-check `pg_database`, `CREATE DATABASE` from `template0`,
restore `auth-schema.sql`, run `migrateToLatest`, close the pool, release. Nothing ever connects to
it again, which is what makes it copyable.

**Cloning** is a file copy — expect a few hundred ms, against the ~1s the truncate+migrate chain
costs today. Retry once on `55006 object_in_use` in case two worktrees clone the same template in
the same instant.

**Cleanup.** The wrapper drops its database and bucket in a `finally` and on SIGINT/SIGTERM. The
backstop for a hard kill is the sweep at the top of the next run: the run id encodes its epoch, so
drop any `fsi_test_run_%` older than 2h with no rows in `pg_stat_activity`. This mirrors
`sweepStaleFixtures` in [concurrency.ts](packages/db/src/testing/concurrency.ts), which already
solves exactly this problem for the unit tier — copy its shape, including the age bound that keeps
a sweep from reaching a live sibling. Templates are small and are *not* age-swept, since another
worktree's branch may be the only user of one; a `pnpm test:db:clean` drops every `fsi_test_%`
instead.

### Everything else

- **`webServer`** loses `pnpm -r run truncate` and `pnpm -r run migrate` (the template is already
  migrated) and `pnpm -r run seed:identity` (the wrapper seeds directly, one connection it already
  holds). The command collapses to `node --env-file-if-exists=../../.env.test start.js`.
  `reuseExistingServer: false`.
- **`playwright.config.ts` must throw if `TEST_RUN_ID` is unset**, naming `pnpm test:e2e` as the
  way in. A bare `playwright test` silently falling back to port 4173 and the shared `postgres`
  database would reintroduce this bug quietly; the guard in
  [lib/screenshots.ts](apps/web/e2e/lib/screenshots.ts) is the precedent for that style.
- **`e2e/setup/database.setup.ts` and the `database` project are deleted**, along with
  `dependencies: ['database']` on `e2e` and `screenshots`. A fresh database has no fixture reports
  to clear. `clearReportFixtures` stays exported for
  [scripts/seed-reports.ts](apps/web/scripts/seed-reports.ts).
- **`.env.test` is unchanged.** It stays the default for the vitest tiers and for manual scripts;
  the wrapper overrides two of its values for the Playwright run only.
- **`pnpm truncate` survives as a manual command.** Nothing automatic ever calls it again.

## PRs

**PR 1 — `@gbd/db`: the auth-schema dump and the run-database helpers.** Prefactor; the suite
behaves identically after it.
- `packages/db/scripts/dump-auth-schema.ts`, modelled directly on the existing
  [dump-schema.ts](packages/db/scripts/dump-schema.ts) (same `scripts/supabase db dump` call, same
  `-- \restrict` stripping, same generated-file header), writing `packages/db/auth-schema.sql`.
  Wire into the `gen-types` script beside `schema.sql`.
- **CI staleness check** (AGENTS.md puts CI off limits *unless that is the task* — it now is). The
  `ts-db-types` job in [.github/workflows/ci.yml:122](.github/workflows/ci.yml#L122) already
  regenerates and diffs `packages/db/schema.sql`; add `packages/db/auth-schema.sql` to that same
  `git diff` list and to the two messages below it. This file matters more than `schema.sql` does:
  its contents are decided entirely by the GoTrue version the pinned Supabase CLI ships, so the
  existing `::notice::` about local CLI drift is exactly the guidance a stale `auth-schema.sql`
  needs.
- `packages/db/src/testing/run-database.ts`, exported from `@gbd/db/testing`:
  `ensureTemplateDatabase()`, `createRunDatabase()`, `dropRunDatabase()`,
  `sweepStaleRunDatabases()`. Tests: fingerprint stability, that a second `ensureTemplateDatabase`
  is a no-op, that a cloned database has the migrated schema, that the sweep spares a young
  database and one with a live connection.

**PR 2 — `@gbd/storage`: per-run buckets.** Prefactor.
- `packages/storage/src/testing/run-bucket.ts`: `createRunBucket()`, `deleteRunBucket()` (empty
  then delete — reuse `emptyBucket`/`ensureBucket` from [buckets.ts](packages/storage/src/buckets.ts)),
  `sweepStaleRunBuckets()`.
- **Spike first:** confirm Supabase Storage's S3 API accepts `DeleteBucket`. If it does not, fall
  back to a per-run key prefix and say so in the file header.

**PR 3 — Wire the Playwright tier onto per-run resources.** The PR that fixes the flake.
- `apps/web/scripts/test-run.ts` as described above.
- `apps/web/package.json`: `test:e2e`, `test:screenshots`, `test:playwright` and
  `screenshots:update` all route through it.
- [playwright.config.ts](apps/web/playwright.config.ts): port from `PLAYWRIGHT_PORT`, the
  `TEST_RUN_ID` guard, `reuseExistingServer: false`, the collapsed `webServer.command`, the
  `database` project and its two `dependencies` entries removed.
- Delete `apps/web/e2e/setup/database.setup.ts`.
- Docs (load the `writing-docs` skill): `.claude/rules/typescript.md` still says "`pnpm test` is
  deliberately serial because `test:e2e` truncates the DB" — that reason is now gone. State that it
  stays serial for machine load alone, which sets PR 4 up.
  `supabase-test/supabase/config.toml`'s header says the suites "assume they can truncate it at
  will" — no longer true. Add `pnpm test:db:clean` to [README.md](README.md)'s command table.

**PR 4 — Experiment: does `pnpm test` still need to be serial?** Depends on PR 3. This is an
experiment with a measurement gate, not a foregone change — it lands only if the numbers say so.
- `pnpm test` is `pnpm run test:unit && pnpm run test:playwright`, and the only stated reason for
  the `&&` was the truncate. With per-run databases the tiers no longer conflict, so the question
  becomes purely one of machine load: five vitest packages plus a browser tier plus Playwright
  workers plus a Docker browser, on 8 cores.
- Measure before deciding, and measure honestly — `pgrep -x yes` and `uptime` first, several
  uncached runs each way (`turbo run test:unit test:playwright` vs. today's serial chain), and
  report the distribution rather than a best case. The cautionary tale: an earlier investigation
  spent a session building a theory that Chromium stalls on this machine for tens of seconds, and
  every measurement behind it had been taken while 12 orphaned `yes` processes — left running by
  that same session — held all 8 cores. On a quiet machine `chromium.close()` is 31ms, not the
  2.3s median it had measured.
- The failure mode to watch for is not a slower suite but a *flakier* one. CPU starvation shows up
  here as a test overrunning its own timeout — a 15,000ms Vitest timeout reported at 42,700ms,
  which is what a stalled tester page looks like once the clock comes back. If parallel is faster
  but produces any timeout-shaped failure, that is a no.
- "Not worth it" is a perfectly good outcome; record it in the PR description and close it.

## Checkpoints during implementation

- **Connection budget.** `max_connections` is 100 and the pool default is 10
  ([client.ts:44](packages/db/src/client.ts#L44)). The worker-scoped `db` fixture means one pool per
  Playwright worker, plus the app server's, times the number of concurrent runs. Watch
  `pg_stat_activity` during the two-run test below and lower the e2e fixture's `maxConnections` if
  it gets close — it needs two or three connections, not ten.
- **Ctrl-C.** A terminal's Ctrl-C signals the whole process group, so the child already dies; the
  wrapper's job is to still reach its `finally`. Verify a Ctrl-C'd run leaves no `fsi_test_run_%`
  database behind, and that if it does, the next run's sweep is what removes it.

## Verification

The test stack must be running: `TEST_DB=1 scripts/supabase start`. Check `pgrep -x yes` and
`uptime` before trusting any timing. An earlier investigation's strongest lead turned out to be
nothing but background load its own session had left running; see PR 4 for the details.

1. `pnpm lint && pnpm check && pnpm test` from the repo root.
2. **The deterministic repro must stop failing.** Start `TEST_DB=1 pnpm --filter @gbd/web run
   test:e2e`; the moment its first test reports, run `TEST_DB=1 pnpm --filter @gbd/db run truncate`
   from another worktree. Today that fails nine specs. After PR 3 it must pass — the truncate hits
   `postgres`, which the run is no longer using. This is a yes/no, not a rate.
3. **Two full suites at once.** `pnpm test` in this worktree and in another, started together, both
   green. Then two at once *in the same worktree*, which is the case the existing plan does not
   cover. Include `--project=screenshots` in at least one pair, since concurrent screenshot runs
   now share one browser container instead of racing to kill and restart it.
4. `psql -c "\l"` afterwards: no `fsi_test_run_%` databases left, one `fsi_test_tmpl_%` per distinct
   migration set. `aws s3 ls`-equivalent: no leftover `files-*` buckets.
5. Confirm the committed PNGs are byte-identical — `git status` clean under
   `apps/web/e2e/__screenshots__/` after a screenshots run. If any changed, the per-run isolation
   leaked into rendering and the design assumption above is wrong.
6. Say plainly if something could not be reproduced or verified. "Could not reproduce" is a real
   result; a silent fix is not.

## Follow-ups this identifies but does not do

- **The `derived_inert` warning.** Every client unit run logs `[svelte] derived_inert — Reading a
  derived belonging to a now-destroyed effect may result in stale values`, and nothing has traced it
  to a component. Untouched by any of this, and tracked separately.
