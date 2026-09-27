# Structured logging

## Context

Every log line in both TypeScript apps is a `console.*` call, and none of it is machine-parseable:
Node prints a context object across several lines, the worker puts ids inside the message string,
and nothing ties a line to the request or worker that wrote it. This plan replaces that with
one JSON object per line on stdout, from [pino](https://getpino.io). It is the half of
[`observability.md`](observability.md) § 2 that needs no vendor and no host. Stdout is the
interface whatever that plan decides: every candidate host reads it, and the process never
learns where its lines go (`ARCHITECTURE.md` § Images).

Facts from the tree (2026-09-27) that shape the design:

- **Browser code imports `@gbd/core`'s root** (`relative-time.svelte`, `(app)/+layout.svelte`), so
  the logger lives at a subpath, `@gbd/core/log`, beside the Node-only `./env`.
- **The web build leaves `@gbd/*` unbundled**, so core's imports resolve at runtime from core's own
  `node_modules`. pino is therefore a runtime `dependency` of core. Both images are built with
  `pnpm deploy --prod`, so core's dev dependencies are absent from them.
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

- **pino, synchronous to stdout, with no transports.** The default destination is synchronous, so
  a process that calls `process.exit` has already flushed what it logged. A transport runs in a
  worker thread that resolves its target by name at runtime: that breaks under a bundler and
  starts another thread on every Vite reload. Nothing here needs one.
  *Considered, not done: a first-party JSON logger*, per AGENTS.md's supply-chain rule.
  Serializers, redaction and child bindings are most of a logger, and they are what we would
  rewrite.
- **Settings are arguments, parsed the way the emailer's are.** `parseLogSettings({ level,
  format })` and `createLogger(settings)` mirror `parseTransportSettings` and `resolveTransport` in
  `@gbd/email`. The worker passes `process.env` and the web app passes `$env/dynamic/private`, so
  `vite dev` and the worker cannot disagree. `LOG_LEVEL` defaults to `info` and `LOG_FORMAT` to
  `json`, so production sets neither. An unknown value of either throws at startup, as
  `authMode()` and `optionalIntEnv` do, so a typo is caught at deploy.
  *Rejected: falling back to JSON with a warning*, since every other setting here fails at boot.
- **`LOG_FORMAT=pretty` is for local development.** `pino-pretty` is a dev dependency of core. It
  is loaded through `createRequire` only when asked for, which keeps `createLogger` synchronous and
  means the images, which lack it, never load it. Asking for it where it is absent throws with a
  message saying so. `.env.example` sets it. `.env.test` sets `LOG_LEVEL=warn`, so the server
  output Playwright pipes shows only what went wrong, not an access line per request.
- **Levels as names, timestamps as ISO strings.** `"level":"error"` rather than pino's `50`, and a
  `time` a person can read in raw output.
- **One error serializer, on every key an error rides under.** pino's `errWithCause` is registered
  on `err`, `error` and `cause`, so a stray key cannot silently write `{}`. New code uses `err`,
  pino's own key, which is where `log.error(error, '…')` puts it. The serializer drops `pg`'s
  `detail` (row values), `internalQuery` and `where` (SQL text). It keeps `code`, `constraint`,
  `table` and `column`, which identify a violation without its data. `describe(error)` in
  `failures.ts` stays the renderer for `failure_detail`; log lines pass the error object.
- **Every record fits in 2,000 bytes.** That is DigitalOcean's per-line forwarding cap, the
  tightest among the hosts `hosting-provider.md` compared, and a line the forwarder splits is one
  no destination can parse. Stacks and the child's stderr tail are what could exceed it. Both are
  trimmed to a bound exported from `@gbd/core/log`, and a looser host only raises it.
- **Ids, never emails.** Call sites log `userId`, `organizationId`, `reportId`, `attemptId` and
  `storageKey`. `redact` on `email` and `to` is the backstop that makes the rule hold without a
  reviewer catching it.
- **Tests read records, not spies.** `@gbd/core/testing` gains a collecting logger whose records
  are the parsed JSON lines, with no timestamp or base bindings. A test then asserts `toEqual` on
  exactly what would have been written, serialization and redaction included, where today it runs
  `toMatchObject` on `console` arguments. Where a seam exists, the logger is a required parameter.
  Where it is a module singleton, it is replaced once in the test project's setup file. Either way,
  a test that forgets cannot spray fd 1.
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
- *Rejected: OpenTelemetry.* Right in the abstract; in practice, three libraries plus a
  collector. Nothing here needs traces, and pino lines carry the same ids.
- *Rejected: forwarding the child's stderr line by line.* Chunks are not lines, so it would need a
  splitter, and a traceback would become dozens of records to reassemble. One record at exit is
  the same diagnostic in one place.
- *Rejected: logging to the database.* The database is the event log for product facts.
  Operational chatter would dwarf it and tie log volume to the connection pool.

Each decision's reasoning lands as a comment on the file that enacts it, since this plan is deleted
with its last PR. `log.ts`'s header carries the pino, transport and OpenTelemetry reasoning,
`spawn.ts` the one-record stderr, and `failures.ts` the streak rule.

## PR 1 — `@gbd/core/log`, and `@gbd/db`'s pool through it

- `packages/core/src/log.ts`, exported as `./log` and headed "Node only" like `env.ts`. It holds
  `parseLogSettings`, `createLogger`, the error serializer and its stack trimming, the record
  bound, `redact`, and the level and time formatters. It re-exports pino's `Logger` type, so
  neither app declares pino itself. pino goes in core's `dependencies` and `pino-pretty` in its
  `devDependencies`, both through the catalog.
- `@gbd/core/testing` gains the collecting logger.
- `DatabaseConfig` gains an optional `log` for the pool's `error` handlers in `client.ts`. Those
  are the outage warnings we most want structured. Without a `log`, the handlers keep today's
  `console` calls, which suits the scripts `@gbd/db/env` serves. `shutdownDatabase` stops logging
  the error it rethrows, since both callers already log it.
- `LOG_LEVEL` and `LOG_FORMAT` go in `turbo.json`'s `globalPassThroughEnv` (Turbo strips variables
  it does not list), `.env.example` and `.env.test`. After this PR, the worker's PRs (2 and 3) and
  the web app's PRs (4 and 5) are independent chains.
- Tests for the settings: unset, each value, and an unknown value throws, naming the variable.
- Tests for the serializer: under each of the three keys; with a three-deep cause chain that
  stays within the bound; and with the `pg` fields dropped. That last one uses a plain `Error`
  with those fields assigned, because core cannot import `@gbd/db/testing`.
- Tests for the rest: redaction, and that `pretty` constructs. In `packages/db`, a pool `error`
  event reaches the injected logger: `warn` for a transient error, `error` otherwise.

## PR 2 — the worker logs through it

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
- `testing/worker-harness.ts` passes a collecting logger. The setup file replaces `log.ts`'s root
  for every test, because `WORKER_DATABASE`'s pool logs through it. `retry.test.ts` moves to the
  sink.
- `biome.json` gains an override turning on `suspicious/noConsole` for `apps/worker/src/**`.

## PR 3 — what the worker says

This PR adds the lines that do not exist yet and fixes the levels of the ones that do.

- **Start.** One `info` line once the bucket check passes, giving the mode and
  `maxConcurrentAttempts`. `WORKER_MODE=off` logs at `info`; the signal and drain lines at `info`,
  or `warn` for a second signal. A comment in `tests/e2e/scripts/containers.ts` says the worker
  "logs nothing on a successful start"; rewrite it. Waiting on the new line for readiness is a
  separate change.
- **Claim.** One `info` line per claim, with `attemptNumber`.
- **Child exit.** One line per exit: the exit code or signal, the runtime, and the stderr tail
  when it is non-empty, trimmed to the record bound. The level is `info` for exit 0, `warn` for 1
  and `error` for a crash. `spawn.ts` keeps its 8 KB tail, because `failure_detail` is built from
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

## PR 4 — the web app logs through it

Mechanical, like PR 2.

- `$lib/server/log.ts` exposes a `logger()` accessor that every server module calls. The root
  singleton it returns sits in a module of its own, built lazily from `$env/dynamic/private` for
  the reason `database()` is lazy: the build imports server modules with no env set. Keeping the
  singleton separate lets the setup file mock the root while PR 5 tests the accessor.
  `database()` passes the logger to `initializeDatabase`.
- Every server `console.*` moves to it: `hooks.server.ts` (`handleError`, and `init`'s shutdown
  lines), `db.ts`, `storage.ts`, `email.ts`, `identify.ts`, `files.ts`, `health/+server.ts`, and
  the three route files. `sendInvite` takes the invite's id and logs it in place of the
  recipient's address.
- `init` installs the process-level handlers, behind its existing listener guard, so `vite dev`
  installs them only once.
- The server test project's setup file routes the root to a collecting logger for every test,
  cleared between tests. The five web test files assert on its records.
- `biome.json`'s `noConsole` override also covers the web app's server code: `src/lib/server/**`,
  `src/hooks.server.ts`, and the `+server.ts`, `+page.server.ts` and `+layout.server.ts` files
  under `src/routes/`.
- `.claude/rules/typescript.md` gains a bullet: server code logs through `@gbd/core/log`, and a
  test asserts on the collecting logger from `@gbd/core/testing`.

## PR 5 — the access log and request ids

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

Each PR is verified by `pnpm lint && pnpm check && pnpm test`; PR 3 also by `pnpm test:system`.
Then by hand, once PR 5 has landed:

- `pnpm dev` prints readable lines, one per request, and none for polls at the default level.
- With `LOG_FORMAT=json`, every line the web server and worker print parses as JSON.
- Stopping the dev database while the worker runs produces two worker lines, not one per poll.
- A forced 500 writes a line whose `requestId` matches the response's `x-request-id`.
- No line contains an email address.
