# Structured logging

## Context

Every log line in both TypeScript apps is a `console.*` call, and none of it is machine-parseable:
Node prints a context object across several lines, the worker puts ids inside the message string,
and nothing ties a line to the request or worker that wrote it. This plan replaces that with
one JSON object per line on stdout, from [pino](https://getpino.io) through `@gbd/core/log`, which
already exists. It is the half of [`observability.md`](observability.md) § 2 that needs no vendor
and no host. Stdout is the interface whatever that plan decides: every candidate host reads it, and
the process never learns where its lines go (`ARCHITECTURE.md` § Images).

The worker's PRs (1 and 2) and the web app's (3 and 4) are independent chains; either can go first.

Facts from the tree (2026-09-27) that shape the design:

- **`@gbd/core/log` is the whole logging surface.** `parseLogSettings({ level, format })` reads
  `LOG_LEVEL` and `LOG_FORMAT` (unset or empty means `info` and `json`; an unknown value throws,
  naming the variable), and `createLogger(settings)` builds the root. It re-exports pino's `Logger`
  type, so neither app declares pino. `MAX_RECORD_BYTES` is the record bound. The error serializer
  is private to the module and already registered on `err`, `error` and `cause`.
- **`@gbd/core/testing` has `collectingLogger()`**, returning `{ log, records, clear() }`. It logs
  at every level, and each record is the parsed line without `time`, `pid` or `hostname`, so a test
  asserts `toEqual` on what production would write, bound and redaction included.
- **`@gbd/db` already logs through it when handed one.** `DatabaseConfig.log` is optional; with it,
  a dropped connection is a `warn` ("Database connection dropped") and anything else an `error`
  ("Unexpected database connection error"), both with `err`. Without it the same lines go to the
  console, for the scripts `@gbd/db/env` serves. Only the client listener logs: pg-pool re-emits an
  idle client's error on the pool, so logging both wrote every drop twice. `shutdownDatabase` no
  longer logs the error it rethrows, so its two callers (`apps/web/src/lib/server/db.ts`,
  `apps/worker/src/main.ts`) must keep logging it.
- **`LOG_LEVEL` and `LOG_FORMAT` are wired.** Turbo passes both through; `.env.example` sets
  `LOG_FORMAT=pretty` and `.env.test` sets `LOG_LEVEL=warn`. Nothing reads them yet.
- **pino writes to the file descriptor, not through `console`**, so vitest's
  `silent: 'passed-only'` cannot hide its output. Today that setting hides the error-path noise in
  every package. The seams for injecting a sink instead already exist: `WorkerDependencies`,
  `RetryOptions`, `DatabaseConfig`, and the web app's module singletons, which tests already
  `vi.mock`.
- **Fifteen `vi.spyOn(console, 'error')` calls in six test files** assert on log lines:
  `hooks.server.test.ts`, `db.test.ts`, `storage.test.ts`, `email.test.ts`, `identify.test.ts`,
  `retry.test.ts`.
- **Errors ride under three keys**: `error:` at most web call sites, `cause:` in
  `reports/+server.ts`, and as a bare second argument in the worker. An `Error` that reaches pino
  under a key with no serializer is written as `{}`, because `message` and `stack` are not
  enumerable. Nothing fails when that happens.
- **Postgres errors carry row values.** `pg`'s `DatabaseError.detail` is where Postgres writes
  "Key (email)=(…) already exists" and "Failing row contains (…)".
- **The claim poll logs every failure, every 2 s** (`pollQueue` in `worker.ts`), so an hour-long
  database outage writes about 1,800 identical lines. The per-attempt retries are small by
  comparison.
- **Progress is a bare counter** (`ProgressSchema` in `apps/worker/src/contract/messages.ts`),
  sampled once per 30 s direct tick.
- **The error page has no failure id, on purpose.** `error-page.svelte`'s comment defers one until
  a user is told to quote it. So the request id goes on a response header and in the log lines,
  not in the error body.

Out of scope: the browser-side `console.error`s in the auth components; CLI output
(`packages/*/scripts`, `packages/db/src/migrate.ts`, `browser-testing`, `tests/e2e/scripts`),
where plain text is right; and the Python child's own logging, which reaches us only as its stderr
tail.

## Decisions

- **Settings come from the caller's environment.** The worker passes `process.env` to
  `parseLogSettings` and the web app passes `$env/dynamic/private`, so `vite dev` and the worker
  cannot disagree. `LOG_FORMAT=pretty` loads pino-pretty, a dev dependency of core that the images
  lack; asking for it there throws with a message saying so.
- **New code puts errors under `err`**, pino's own key, which is where `log.error(error, '…')`
  puts it. `error` and `cause` are serialized too, so the existing call sites cannot write `{}`
  while they move over. The serializer drops `pg`'s `detail`, `internalQuery` and `where`, trims
  stacks and messages, follows at most four levels of cause and three aggregated errors.
  `describe(error)` in `failures.ts` stays the renderer for `failure_detail`; log lines pass the
  error object.
- **Every record fits in `MAX_RECORD_BYTES` (2,000).** That is DigitalOcean's per-line forwarding
  cap, the tightest among the hosts `hosting-provider.md` compared. The error serializer keeps
  ordinary records under it. Past that, the write drops the record's largest fields and names them
  under `truncated`, so a field that is too big disappears whole. The child's stderr tail is the
  one field that will hit this, so the worker trims it itself, keeping the end, before logging it.
- **Ids, never emails.** Call sites log `userId`, `organizationId`, `reportId`, `attemptId` and
  `storageKey`. `redact` on `email` and `to` is the backstop that makes the rule hold without a
  reviewer catching it. It also covers one level down (`user.email`).
- **Tests read records, not spies.** A test asserts `toEqual` on `collectingLogger()`'s records,
  where today it runs `toMatchObject` on `console` arguments. Where a seam exists, the logger is a
  required parameter. Where it is a module singleton, it is replaced once in the test project's
  setup file. Either way, a test that forgets cannot spray fd 1.
- **The request id is ours, generated per request.** `handle` calls `randomUUID()`, returns the
  id as `x-request-id`, and binds it to every line the request writes. The header also lands in
  Playwright traces, which joins a failed e2e request to its server line.
  *Rejected: adopting an inbound id.* The edge's `cf-ray` exists only on some hosts, and any
  client can send one. Once the host is chosen, its id can join the access line as an extra field.
- **The worker logs events, not ticks.** It logs a start, a claim, a child's exit and a settle,
  never a poll. A loop that is failing (the claim poll, each ticker) logs the first failure of a
  streak and then its recovery, with how long it lasted and how many ticks failed. An outage
  becomes two lines. This extends `absorb-or-fail` in `failures.ts`. `retryOnTransientDbError`
  logs each retry it is about to make at `warn` and rethrows the last failure unlogged, because
  every caller already logs it along with what happens next: parking the verdict, or failing the
  attempt.
- *Rejected: forwarding the child's stderr line by line.* Chunks are not lines, so it would need a
  splitter, and a traceback would become dozens of records to reassemble. One record at exit is
  the same diagnostic in one place.
- *Rejected: logging to the database.* The database is the event log for product facts.
  Operational chatter would dwarf it and tie log volume to the connection pool.

Each decision's reasoning lands as a comment on the file that enacts it, since this plan is deleted
with its last PR. `packages/core/src/log.ts` already carries the pino, transport, OpenTelemetry,
serializer and bound reasoning. `spawn.ts` is to carry the one-record stderr, and `failures.ts` the
streak rule.

## PR 1 — the worker logs through it

Mechanical: every line the worker writes today, now as a structured record at the same point.

- `apps/worker/src/log.ts` builds the root logger from `process.env`. It is a module singleton for
  the same reason `WORKER_DATABASE` is one: the pool is built at import, before `main` runs, and
  logs through the unbound root.
- `WorkerDependencies` gains a required `log`, which `main.ts` binds to `workerId`.
  `AttemptDependencies` carries it into `attempt/` and `sweeps/`. Each in-flight attempt holds a
  child logger bound to `attemptId` at the claim and to `reportId` once `startAttempt` has loaded
  it, since a support question starts from a report. `startTicker`, `RetryOptions` and
  `spawnChild`'s options each take a logger.
- Ids move out of the message strings into fields, and errors go under `err`.
- `main.ts` installs `uncaughtException` and `unhandledRejection` handlers that log one record and
  exit 1, and its own `.catch` logs through the same logger. Today Node's multi-line trace
  arrives at the host as one entry per line.
- `testing/worker-harness.ts` passes a `collectingLogger()`. The setup file replaces `log.ts`'s root
  for every test, because `WORKER_DATABASE`'s pool logs through it. `retry.test.ts` moves to the
  sink.
- `biome.json` gains an override turning on `suspicious/noConsole` for `apps/worker/src/**`.

## PR 2 — what the worker says

This PR adds the lines that do not exist yet and fixes the levels of the ones that do.

- **Start.** One `info` line once the bucket check passes, giving the mode and
  `maxConcurrentAttempts`. `WORKER_MODE=off` logs at `info`; the signal and drain lines at `info`,
  or `warn` for a second signal. A comment in `tests/e2e/scripts/containers.ts` says the worker
  "logs nothing on a successful start"; rewrite it. Waiting on the new line for readiness is a
  separate change.
- **Claim.** One `info` line per claim, with `attemptNumber`.
- **Child exit.** One line per exit: the exit code or signal, the runtime, and the stderr tail
  when it is non-empty, trimmed from the front to leave room for the rest of the record under
  `MAX_RECORD_BYTES`. The level is `info` for exit 0, `warn` for 1 and `error` for a crash. `spawn.ts` keeps its 8 KB tail, because `failure_detail` is built from
  it. This line recovers the Python child's warnings from runs that did not crash, which today
  reach nowhere.
- **Settle.** One line when a verdict is recorded, with the outcome and, for a failure, its
  `failure_reason`. The level is `info` for a success and `warn` for a failure. Alerting on
  failures belongs to the metrics layer (`observability.md` § 4), so the level is for a person
  scanning the log, not for a threshold.
- **Progress.** An advance logs at `debug`: a bare counter says only that the child is alive.
- **Outages.** The failure-streak rule from Decisions, as one helper shared by `pollQueue` and
  `startTicker` and cited from `absorb-or-fail`. `retryOnTransientDbError` logs at `warn`, and not
  on its last try.
- Tests assert each line as a record, through the harness's logger: a claim, a success, a crash
  with its tail, and an over-long tail trimmed to the bound. Three failed polls followed by a
  success produce two records. Also run `pnpm test:system`, which covers the start line and the
  stderr record, since only that tier runs the real child in the real image.

## PR 3 — the web app logs through it

Mechanical, like PR 1.

- `$lib/server/log.ts` exposes a `logger()` accessor that every server module calls. The root
  singleton it returns sits in a module of its own, built lazily from `$env/dynamic/private` for
  the reason `database()` is lazy: the build imports server modules with no env set. Keeping the
  singleton separate lets the setup file mock the root while PR 4 tests the accessor.
  `database()` passes the logger to `initializeDatabase` as `log`.
- Every server `console.*` moves to it: `hooks.server.ts` (`handleError`, and `init`'s shutdown
  lines), `db.ts`, `storage.ts`, `email.ts`, `identify.ts`, `files.ts`, `health/+server.ts`, and
  the three route files. `sendInvite` takes the invite's id and logs it in place of the
  recipient's address.
- `init` installs the process-level handlers, behind its existing listener guard, so `vite dev`
  installs them only once.
- The server test project's setup file routes the root to a `collectingLogger()` for every test,
  and calls `clear()` between tests. The five web test files assert on its records.
- `biome.json`'s `noConsole` override also covers the web app's server code: `src/lib/server/**`,
  `src/hooks.server.ts`, and the `+server.ts`, `+page.server.ts` and `+layout.server.ts` files
  under `src/routes/`.
- `.claude/rules/typescript.md` gains a bullet: server code logs through `@gbd/core/log`, and a
  test asserts on the collecting logger from `@gbd/core/testing`.

## PR 4 — the access log and request ids

- `handle` starts by generating the request id and putting a child logger bound to it on
  `event.locals.log`; `App.Locals` gains `log`. Inside a request, `logger()` returns that child
  through `getRequestEvent()`. Where `getRequestEvent()` throws (outside a request, or in a test
  that calls a helper directly), it falls back to the root. That way `withDbErrorHandling` and
  `withBlobStoreErrorHandling`, which have no `event`, get the id with no change to their
  signatures.
- One access line per request, written in a `try/finally` that wraps both `resolveAuth` and
  `resolve`, because `resolveAuth` can throw before `resolve` runs. Its fields:
  - `method`, `routeId` and `path`. The path is the pathname only: paths here hold slugs and
    uuids, never a secret, and the query string is not logged.
  - `status`: a thrown `HttpError`'s status, otherwise 500.
  - `durationMs` and `userId`.

  The two `poll` routes and `/health` log at `debug`; everything else at `info`. Static assets
  never reach `handle`.
- `x-request-id` goes on the response. A request whose `handle` throws gets SvelteKit's own error
  response, without the header, but its lines still carry the id. `containers.ts` passes
  `.env.test`'s `LOG_LEVEL` to the web container, so the system tier is as quiet as the others.
- Tests in `hooks.server.test.ts` cover the access record for a success, for a `resolveAuth` that
  throws a 503, and at `debug` for a poll route. They also cover the header, and that a
  `withDbErrorHandling` failure inside a request carries that request's id (with `$app/server`
  mocked).
- This PR deletes this plan, and turns `observability.md`'s pointers to it into pointers to
  `@gbd/core/log`.

## Verification

Each PR is verified by `pnpm lint && pnpm check && pnpm test`; PR 2 also by `pnpm test:system`.
Then by hand, once PR 4 has landed:

- `pnpm dev` prints readable lines, one per request, and none for polls at the default level.
- With `LOG_FORMAT=json`, every line the web server and worker print parses as JSON.
- Stopping the dev database while the worker runs produces two worker lines, not one per poll.
- A forced 500 writes a line whose `requestId` matches the response's `x-request-id`.
- No line contains an email address.
