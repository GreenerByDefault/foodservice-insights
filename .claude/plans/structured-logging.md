# Structured logging

## Context

Every log line in both TypeScript apps was a `console.*` call, and none of it was
machine-parseable: Node prints a context object across several lines, the worker put ids inside the
message string, and nothing tied a line to the request or worker that wrote it. This plan replaces
that with one JSON object per line on stdout, from [pino](https://getpino.io) through
`@gbd/core/log`. It is the half of [`observability-vendors.md`](observability-vendors.md) § 2 that
needs no vendor and no host. Stdout is the interface whatever that plan decides: every candidate
host reads it, and the process never learns where its lines go (`ARCHITECTURE.md` § Images).

Both apps' server code now logs through it, the worker at the levels below and in events rather
than ticks. What is left is one PR: the web app's access log and request ids, so that a web line
can be tied to its request.

Facts from the tree (2026-09-28) that shape the design:

- **`@gbd/core/log` is the whole logging surface.** `parseLogSettings({ level, format })` reads
  `LOG_LEVEL` and `LOG_FORMAT` (unset or empty means `info` and `json`; an unknown value throws,
  naming the variable), and `createLogger(settings)` builds the root. It re-exports pino's `Logger`
  type, so neither app declares pino. `MAX_RECORD_BYTES` is the record bound. The error serializer
  is private to the module and already registered on `err`, `error` and `cause`.
- **`@gbd/core/testing` has `collectingLogger()`**, returning `{ log, records, clear() }`. It logs
  at every level, and each record is the parsed line without `time`, `pid` or `hostname`, so a test
  asserts `toEqual` on what production would write, bound and redaction included.
- **`@gbd/db` already logs through it when handed one.** `DatabaseConfig.log` is required, a
  `Logger` or `'console'`; with a logger, a dropped connection is a `warn` ("Database connection
  dropped") and anything else an `error` ("Unexpected database connection error"), both with `err`.
  `'console'` writes the same lines to the console. Both apps pass their root; scripts and test
  helpers keep `'console'`. Only the client listener logs: pg-pool re-emits an idle client's error
  on the pool, so logging both wrote every drop twice. `shutdownDatabase` no longer logs the error
  it rethrows, so its two callers (`apps/web/src/lib/server/db.ts`, `apps/worker/src/main.ts`) must
  keep logging it.
- **`LOG_LEVEL` and `LOG_FORMAT` are wired.** Turbo passes both through; `.env.example` sets
  `LOG_FORMAT=pretty` and `.env.test` sets `LOG_LEVEL=warn`. The worker reads them from
  `process.env`, the web app from `$env/dynamic/private`.
- **The worker's loggers are parameters, bar one.** `WORKER_LOG` in `apps/worker/src/log.ts` is
  the root, a singleton because `WORKER_DATABASE`'s pool logs through it at import. `main.ts` binds
  it to `workerId` and passes that as `WorkerDependencies.log`, which `AttemptDependencies.log`,
  `NotifyDependencies.log`, `RetryOptions.log` and `SpawnChildOptions.log` carry onward.
  `startAttempt` binds `attemptId` and `reportId` into `PreparedAttempt.log`, which every line
  about an in-flight attempt goes through;
  `recordVerdict` takes an `AttemptLog` (`{ attemptId, log }`) for the same reason. `main.ts` also
  logs `uncaughtException` and `unhandledRejection` as one `fatal` record and exits 1. `biome.json`
  turns on `suspicious/noConsole` for `apps/worker/src/**`.
- **The worker's levels are settled.** `info` for the start line, each claim, a clean exit and a
  recorded success; `warn` for a declared failure, a failed verdict, a second signal and each
  database retry; `error` for a crash and for what the worker could not do; `debug` for progress.
  A failing loop goes through `failureStreak` in `failures.ts`, which logs the first failure of a
  streak and its recovery — the claim poll and every `startTicker` take one. Each exit is one
  record from `spawn.ts`, its stderr tail trimmed from the front to fit the bound.
- **The web app's server code calls `logger()`** from `#lib/server/log.ts`, which today just
  returns `rootLogger()`. That root sits alone in `#lib/server/root-log.ts`, built lazily for the
  reason `database()` is lazy, so that the server test project's setup file can mock it onto
  `SERVER_LOGS` (a `collectingLogger()` in `#lib/server/testing/logs.ts`, cleared before each test)
  while `logger()` itself stays real. `sendInvite(inviteId, message)` logs the invite's id, not the
  recipient. `init` installs the same two `fatal` process handlers as the worker, behind its
  listener guard. `biome.json`'s `noConsole` covers `src/lib/server/**`, `src/hooks.server.ts` and
  the server route files.
- **Worker tests already read records.** The setup file `vi.mock`s `log.ts` onto a
  `collectingLogger()`, and the harness gives each worker its own, exposed as `harness.logs`.
  `worker.test.ts` asserts the claim, exit and verdict records of a whole attempt.
- **pino writes to the file descriptor, not through `console`**, so vitest's
  `silent: 'passed-only'` cannot hide its output. Today that setting hides the error-path noise in
  every package. The seams for injecting a sink instead already exist: `WorkerDependencies`,
  `RetryOptions`, `DatabaseConfig`, and the web app's module singletons, which tests already
  `vi.mock`.
- **Every call site puts its error under `err`.** An `Error` that reaches pino under a key with no
  serializer is written as `{}`, because `message` and `stack` are not enumerable, and nothing
  fails when that happens.
- **Postgres errors carry row values.** `pg`'s `DatabaseError.detail` is where Postgres writes
  "Key (email)=(…) already exists" and "Failing row contains (…)".
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
- **Errors go under `err`**, pino's own key, which is where `log.error(error, '…')` puts it. `error`
  and `cause` are serialized too, as a backstop for a call site that strays. The serializer drops
  `pg`'s `detail`, `internalQuery` and `where`, bounds stacks, messages and every other field,
  follows at most four levels of cause and three aggregated errors, and halves those bounds until
  the error fits in 1,400 bytes. Stack frames lose their path up to `node_modules/` or the working
  directory. `describe(error)` in `failures.ts` stays the renderer for `failure_detail`; log lines
  pass the error object.
- **Every record fits in `MAX_RECORD_BYTES` (2,000).** That is DigitalOcean's per-line forwarding
  cap, the tightest among the hosts `hosting-provider.md` compared. The error serializer keeps
  ordinary records under it. Past that, the write keeps any error, then the smallest fields, and
  names the rest under `truncated`, so a field that is too big disappears whole. The child's stderr tail is the
  one field that will hit this, so the worker trims it itself, keeping the end, before logging it.
- **Ids, never emails.** Call sites log `userId`, `organizationId`, `reportId`, `attemptId` and
  `storageKey`. `redact` on `email` is the backstop that makes the rule hold without a reviewer
  catching it. It also covers one level down (`user.email`). Not `to`, which is as often a state or
  a date as a recipient.
- **Tests read records, not spies.** A test asserts `toEqual` on `collectingLogger()`'s records.
  Where a seam exists, the logger is a required parameter. Where it is a module singleton, it is
  replaced once in the test project's setup file. Either way, a test that forgets cannot spray fd 1.
- **The request id is ours, generated per request.** `handle` calls `randomUUID()`, returns the
  id as `x-request-id`, and binds it to every line the request writes. The header also lands in
  Playwright traces, which joins a failed e2e request to its server line.
  *Rejected: adopting an inbound id.* The edge's `cf-ray` exists only on some hosts, and any
  client can send one. Once the host is chosen, its id can join the access line as an extra field.
- *Rejected: logging to the database.* The database is the event log for product facts.
  Operational chatter would dwarf it and tie log volume to the connection pool.

Each decision's reasoning lands as a comment on the file that enacts it, since this plan is deleted
with its last PR. `packages/core/src/log.ts` already carries the pino, transport, OpenTelemetry,
serializer and bound reasoning, `apps/worker/src/log.ts` the singleton, `spawn.ts` the one-record
stderr, and `failures.ts` the streak rule. The request id's reasoning is still to land, in
`hooks.server.ts`.

## PR 1 — the access log and request ids

- `handle` starts by generating the request id and putting a child logger bound to it on
  `event.locals.log`; `App.Locals` gains `log`. Inside a request, `logger()` returns that child
  through `getRequestEvent()`. Where `getRequestEvent()` throws (outside a request, or in a test
  that calls a helper directly), it falls back to the root. The setup file mocks only
  `root-log.ts`, so this runs for real in tests. That way `withDbErrorHandling` and
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
- Tests in `hooks.server.test.ts`, reading `SERVER_LOGS`, cover the access record for a success, for
  a `resolveAuth` that throws a 503, and at `debug` for a poll route. They also cover the header,
  and that a `withDbErrorHandling` failure inside a request carries that request's id (with
  `$app/server` mocked).
- This PR deletes this plan, and turns `observability-vendors.md`'s pointers to it into pointers
  to `@gbd/core/log`.

## Verification

The PR is verified by `pnpm lint && pnpm check && pnpm test`. Then by hand, once it has landed:

- `pnpm dev` prints readable lines, one per request, and none for polls at the default level.
- With `LOG_FORMAT=json`, every line the web server and worker print parses as JSON.
- Stopping the dev database while the worker runs produces two worker lines, not one per poll.
- A forced 500 writes a line whose `requestId` matches the response's `x-request-id`.
- No line contains an email address.
