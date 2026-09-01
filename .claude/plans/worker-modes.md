# Worker modes: running the whole lifecycle locally

## Context

`pnpm dev` starts the web app and five `tsc --watch` processes. **Nothing starts the worker.** So a
report uploaded in dev sits `pending` forever: you can exercise the upload form and the rejection
view by hand, but never the waiting screen's transitions, the result screen arriving, a failure
arriving, Cancel racing a live child, or the result email. Those states are reachable today only by
writing rows directly — `pnpm seed:reports` for a static look, or a Playwright fixture inside a
test. Tests are not a substitute for a human watching the thing behave, especially for how it looks
mid-transition and on a small screen.

The blocker was assumed to be the Python port. It isn't. `python/worker_child` is **complete and
working**; only `gbd_foodservice_insights.analyze()` raises `NotImplementedError`. And
`worker_child.run.run()` already takes an injectable `analyze`, while
`gbd_foodservice_insights.testing.stub_analysis` already ships an `analyze` that writes real
PDF/xlsx magic bytes and raises each failure type on demand. The whole lifecycle is one entrypoint
and one env var away.

**Outcome:** `WORKER_MODE` in `.env` picks how the analysis is faked; `pnpm dev` runs a worker in
that mode; a dev drives scenarios by naming the report `!hang`, `!slow:90`, `!fail:unusable-data`;
and `tests/e2e` becomes a real suite instead of a README.

## The three modes

All three run the real `python -m worker_child`. They differ only in which `analyze` is injected —
so the queue, the run directory, the contract documents, the exit codes, the upload, the database
write and the email are real in every mode.

| `WORKER_MODE` | `analyze` | Needs | Available |
| --- | --- | --- | --- |
| `stubbed` | `stub_analysis`, steered by the report name | `uv sync` | now |
| `mock-llm` | the real library, LLM calls mocked | the port | **not yet** — fails at startup with a clear message |
| `live` | the real library, real API keys | keys, spend | now (raises `NotImplementedError` until the port) |
| `off` | — | — | escape hatch: `pnpm dev` starts no worker |

`mock-llm` is deliberately a named-but-unavailable value rather than a TODO: it is the slot the port
fills, and the port's PR becomes a one-line change here.

## Design

### The scenario travels in the report name

`AnalysisRequest.report_name` is already handed to `analyze()` — the manifest is already parsed, the
contract is already carrying it. So a scenario needs **no change to `apps/web`, no new column, and no
widening of the parent ↔ child seam** (which `fake-child.ts` and `tests/support/child.py` both call
out as a rule: the seam cannot be widened to make testing easier).

Grammar: `!<scenario>` or `!<scenario>:<argument>`. A name not starting with `!` is the happy path.
An unrecognised `!name` raises, so `failure.json` names the valid scenarios back at you.

| Report name | What happens | What you get to watch |
| --- | --- | --- |
| anything else | progress ×2, succeed | the result screen arriving |
| `!slow` / `!slow:90` | progress every few seconds for N seconds (default 60), then succeed | the waiting timeline, the poll, Cancel |
| `!hang` | one progress, then nothing, forever | the parent killing it as `hung` |
| `!crash` | raise a bare `RuntimeError` | `failed('unknown')` |
| `!fail:<reason>` | `stub_analysis(raises=…)` — `upstream-api`, `unusable-data`, `invalid-input` | each failure screen's copy |
| `!missing-pdf` | `stub_analysis(write_pdf=False)` | the parent's declared-but-missing-file → `contract_violation` |

The one limit: a scenario can only affect what happens *inside* `analyze()`, so it cannot make the
child exit without writing a verdict, ignore SIGTERM, or leak a grandchild. Those are parent-torture
cases `apps/worker/src/worker.test.ts` already owns against `fake-child.ts`, and a human does not
need to eyeball them.

Nothing needs to make the name unique: there is no unique constraint on `report.name` (only
`organization_name_unique_ci`, on `organization`), and `organization-slugs.md` keeps reports on
UUIDs. So the same `!hang` can be typed all day, and `apps/web` injects nothing.

### The rate limit has to be defeatable in dev

`HOURLY_REPORT_LIMIT` is 5 and `WEEKLY_REPORT_LIMIT` is 20, per organization *and* per user, counted
on real `created_at` — so walking the scenario catalogue hits the hourly wall on the sixth upload.
That is what would otherwise force a `pnpm truncate`.

`REPORT_RATE_LIMIT=off` in `.env`, read via `$env/dynamic/private` inside `checkReportRateLimit`
(`apps/web/src/lib/server/reports/rate-limit.ts`) as an early `return undefined`. That one function
is the choke point for both the enforcement path (`lockAndCheckReportRateLimit`) and the advisory
display. Read it inside the function, not at module scope, so the existing unit tests are
unaffected. An absent variable means the limits apply, so it cannot leak to production.
`apps/web/src/lib/reports/limits.ts` stays untouched — the browser imports it and its header forbids
`$env`.

### No new TypeScript child

`apps/worker/src/testing/fake-child.ts` stays exactly as it is — test-only, argv-driven, excluded
from `tsconfig.build.json`. Nothing to DRY: the contrived mode is Python, so it exercises
`worker_child`'s real writers against the parent's real readers, which is precisely the gap
`fake-child.ts`'s own header names.

`python/worker_child/tests/support/child.py` also stays as it is. It shares `stub_analysis` and a
small `raises` mapping with the new module, but its scenarios arrive as argv JSON and exist to
torture `run.py` from pytest. Duplicating a six-entry dict is cheaper than one module serving two
argument conventions.

### Per-mode config profiles

`directIntervalMs` defaults to 30s, so a child that finishes in a second stays `processing` on screen
for up to 30 more. `killAfterNoProgressMs` defaults to 10 minutes, so `!hang` is unwatchable. Each
mode therefore carries a config profile:

- **`stubbed`** — fast everything, including `killAfterNoProgressMs: 30 * SECOND_MS` so `!hang` lands
  while you are still looking at it.
- **`mock-llm`** — fast ticks, production kill thresholds (a real analysis can legitimately go quiet
  between progress calls).
- **`live`** — `WORKER_DEFAULTS`, untouched. Never given a dev profile, because `live` is the value
  production will set.

`createWorkerConfig` enforces ~12 cross-field relations, so a profile cannot be written by eye. A
consistent `stubbed` profile: `queuePollIntervalMs 1s`, `directIntervalMs 1s`,
`killAfterNoProgressMs 30s`, `killAfterTotalRuntimeMs 5min`, `killGraceMs 5s`, `reapIntervalMs 5s`,
`notifyIntervalMs 5s`, `claimedCeilingMs 15min`, defaults elsewhere. `apps/worker/src/testing/worker-harness.ts`'s
`TEST_CONFIG` is the precedent for the shape; do not import it (it pulls in vitest).

## Which mode each system test uses

Only the **happy path** moves to `mock-llm` when the port lands. The failure tests stay `stubbed`,
permanently.

The two modes answer different questions. `mock-llm`'s value is fidelity — real CSV parsing, real
emissions maths, a real PDF, a realistic progress cadence, which is the only thing that ever
validates `killAfterNoProgressMs` against a real workload. That is exactly what the happy path
wants. A failure test wants the opposite: `!fail:unusable-data` fires precisely that failure,
instantly, every time. Reaching the same failure under `mock-llm` would mean constructing input data
that genuinely provokes the library's judgement — slower, more brittle, and it would be testing the
library's judgement rather than the wiring, which is all this tier is for.

**Two modes means two workers, and two workers cannot share one queue** — `claimNextAttempt` is
`FOR UPDATE SKIP LOCKED`, so whichever polls first takes the attempt and a `!fail:*` report could
land on the `mock-llm` worker. So when the port arrives, the happy path moves to a second Playwright
project with its own run database, bucket, and worker. Today there is one worker, in `stubbed` mode,
and both tests share it.

## PR order

Five PRs left. `REPORT_RATE_LIMIT=off` has landed — the guard described above, plus
`REPORT_RATE_LIMIT` in `.env.example` and `turbo.json`'s `globalPassThroughEnv`, and a unit test for
both branches of `checkReportRateLimit`.

The first two below are independent of each other and can land in any order; PR 3 needs PR 1, PR 4
needs PR 3, PR 5 needs PR 2 and PR 3.

## PR 1 — the stubbed child (Python only)

New `python/worker_child/src/worker_child/testing.py`: the scenario catalogue, a `build_analyze()`
that reads `request.report_name`, and a `main()` so it runs as
`python -m worker_child.testing <runDirectory>`. It calls the real
`worker_child.run.run(run_directory, analyze=…)`, so `run.py` and `__main__.py` are untouched.

Add `"**/testing.py" = ["TID251"]` to `[tool.ruff.lint.per-file-ignores]` in the root
`pyproject.toml`, alongside the existing `python/worker_child/tests/**` entry. The rule this states:
a package's shipped `testing.py` may import another package's `testing.py`; product modules may not.
`gbd_foodservice_insights/testing.py` is the precedent for shipping a test helper in the wheel.

Tests in `python/worker_child/tests/`: the grammar parses (including `:argument` and the unknown-name
failure), and each scenario produces the outcome it claims. Nothing in TypeScript consumes this yet,
so it lands and is verified entirely with `just`.

## PR 2 — extract `@gbd/browser-testing`

Prefactor, so PR 6 has something to import. New `packages/browser-testing/`, seeded with the
Playwright helpers both suites need: `advancePoll` and `advanceThroughPollFailures` from
`apps/web/e2e/lib/fake-poll.ts`, and `ensureHydrated` from `apps/web/e2e/lib/hydration.ts`.
`apps/web` takes it as a `devDependency` (test-only, so not a `dependency`), and
`apps/web/e2e/lib/fake-poll.ts` shrinks to re-exports so no existing spec changes.

The **mechanics** move; the **interval** does not. `fake-poll.ts` re-exports
`BASE_POLL_INTERVAL_MS` from a deep `apps/web` route path, which `tests/e2e` cannot import across the
package boundary. So each suite keeps its own constant: `apps/web` its re-export, `tests/e2e` a local
value with a comment that it must exceed the app's poll interval. A UI polling cadence does not
belong in `@gbd/core`, and the drift risk is one number that only ever makes a test slower.

Leave `no-reload.ts`, `layout.ts`, and `viewports.ts` in `apps/web/e2e/lib/` — move them if the
system suite turns out to want them, not speculatively.

Coordinate with `.claude/plans/organization-reports-list.md` PR 4, which moves
`polling/schedule.ts` into `apps/web/src/lib/polling/` — that changes the path `fake-poll.ts`
re-exports from.

## PR 3 — the mode switch, and `pnpm dev` runs the worker

New `apps/worker/src/modes.ts` — `resolveWorkerMode(env)` returning `{ childCommand, overrides }`,
plus a `modes.test.ts` decision table in the style of `config.test.ts` (no database, no child, no
clock). `apps/worker/src/main.ts` calls it instead of building `childCommand` inline. `WORKER_MODE`
is a `requireEnv`, not a defaulted value, so a stale `.env` fails loudly at startup rather than
silently running `live` into `NotImplementedError`.

`apps/worker`'s `dev` script changes from `tsc --watch` to running the worker under `node --watch`
(Node 24 strips types, and `dependsOn: ["^build"]` already builds the `@gbd/*` dependencies). The
worker loses its type-watch; the editor's TS server and `pnpm check` cover that.

`.env.example` and `.env.test` gain `WORKER_MODE`, and **fix `PYTHON_BIN`** — `python3` is the bare
system interpreter, which cannot import `worker_child`; the correct value is the repo venv
(`.venv/bin/python`). Add `WORKER_MODE` to `turbo.json`'s `globalPassThroughEnv`.

Docs: `apps/worker/README.md` gains the mode table, and root `README.md` a short "Running the worker
locally" subsection — the modes, the scenario grammar, `WORKER_MODE=off`, `REPORT_RATE_LIMIT=off`.
The scenario catalogue itself stays in `worker_child/testing.py`, with the READMEs pointing at it.

This is the first point at which `pnpm dev` gives you the whole lifecycle.

## PR 4 — delete `pnpm seed:reports`

A pure removal, once PR 3 has provided the replacement: `apps/web/scripts/seed-reports.ts`, the
turbo task, the root and `apps/web` scripts, and the README line under § Seeding.

**The fixtures stay.** `apps/web/e2e/fixtures/reports.ts` is what the screenshot suite and several
e2e specs are built on, and `.claude/plans/organization-reports-list.md`'s proposed `organizations`
factory is where bulk seeding for the list screen belongs. Only the script is redundant:

- Every state it seeds is now reachable through the real path in seconds — `!slow` for `processing`,
  `!fail:*` for `failed`, Retry for `failed-retried` (`MAX_ANALYSIS_ATTEMPTS` is 5), Cancel during
  `!slow` for `canceled`, `WORKER_MODE=off` for `pending`.
- A live run is better evidence. A fixture can commit a row the system could never produce; an
  upload cannot.
- It has already drifted unnoticed: `STATES` names `'failed-later-attempt'`, no longer a
  `ReportState`, so the script throws partway — and it escapes `svelte-check`, because
  `apps/web/scripts/` is outside the generated tsconfig's includes.
- Deleting it dissolves a collision instead of managing it. A live worker claims the seeded `pending`
  and `pending-delayed` rows (whose input files have no real blob object, so they fail) and reaps
  `processing` and `processing-delayed` as `abandoned`. Only terminal rows are immune, so trimming
  the list instead would have left a permanent footnote in the README.

Genuinely lost: `processing-delayed`, the 15-minute overrun copy, whose only live path is `!slow:1000`
and a wait. It keeps its component test and its committed screenshot, and a row can still be
hand-edited in Supabase Studio at <http://localhost:55323>.

**Hand off to `.claude/plans/organization-reports-list.md`**, which references the script twice: its
PR 2 plans to fix the `STATES` drift — now nothing to do — and its verification step 7 (a `pnpm dev`
walkthrough with a mix of states) should use the live worker or its own `organizations` factory.

## PR 5 — `tests/e2e` becomes `@gbd/e2e`

CI is already waiting: `.github/workflows/ci.yml`'s `system-e2e` job runs `turbo run test:system`,
gated on `tests/e2e/package.json` existing, and `.github/filters.yml` already has a `system` filter.
Missing: the package, the turbo task, a root script, a Playwright config, and a run script.

`tests/e2e/scripts/test-run.ts` mirrors `apps/web/scripts/test-run.ts` and reuses the same machinery
— `ensureTemplateDatabase`/`createRunDatabase`/`dropRunDatabase` from
`packages/db/src/testing/run-database.ts`, `createRunBucket`/`deleteRunBucket` from
`packages/storage/src/testing/run-bucket.ts`. The new part is spawning a **worker** alongside, in
`stubbed` mode, pointed at the same run database and bucket with a temporary `WORKER_RUN_ROOT`, and
SIGTERMing it in `finally`. Playwright's `webServer` cannot host it — it demands a readiness URL and
the worker serves no HTTP — so the run script owns its lifecycle, which is where the per-run database
and bucket already live.

**These tests must be fast.** Both use `page.clock` through `@gbd/browser-testing` rather than
waiting out real 10-second polls; `page.clock.install()` goes in the spec before `page.goto()`, as
`fake-poll.ts`'s header explains. The scenarios are chosen to finish immediately: the happy path is
a plain report name, not `!slow`.

Two tests:

1. **Happy path** — upload a CSV through the form, advance through `pending` → `processing` →
   `succeeded`, download the PDF and assert `stub_analysis`'s magic bytes came back, and assert the
   result email via `waitForEmail` from `@gbd/email/testing`. `PLACEHOLDER_USER_EMAIL` is a fixed
   `phase-one@example.test`, so either match on the report or subject, or have the run script give
   the run's placeholder user an `aTestEmailAddress()`.
2. **A child-claimed failure** — name the report `!fail:unusable-data` and assert the failure screen.
   Worth having because it is a real `failure.json`, written by the real writer and parsed by the
   real parent reader.

Deliberately **not** covered: the other failure reasons and the parent-torture cases.
`apps/worker/src/worker.test.ts` owns those against `fake-child.ts`, and `apps/web/e2e` owns the
failure copy against seeded rows.

`tests/e2e/README.md` records what the port supersedes. **Survives:** the whole chain — browser → web
app → Postgres → worker parent → Python child → blob store → email — and the contract round trip
between the parent's readers and the child's real writers. **Replaced by `mock-llm`:** the happy
path's *content* (a 15-byte stub PDF becomes a real report; `resultMetadata` becomes real) and its
timing and progress cadence. The failure test does not move, and why — see § Which mode each system
test uses.

## Verification

Per PR, from the repo root. The gate is `pnpm lint && pnpm check && pnpm test` for anything
TypeScript and `just lint && just check && just test` for anything Python, on top of what follows.

- **PR 1** — `just` only; nothing consumes it yet.
- **PR 2** — `pnpm test:playwright`. A pure move, so the existing specs passing unchanged is the
  proof.
- **PR 3** — `pnpm dev`, then walk the catalogue in a browser: a plain upload succeeds; `!slow:90`
  holds on the waiting screen and can be canceled; `!hang` is killed as `hung` within ~30s;
  `!fail:unusable-data` and `!missing-pdf` land on the right failure copy; Retry on a failed report
  reaches `failed-retried`; the result email appears at <http://localhost:55324>. Check the waiting
  and result screens at 390px. Confirm `WORKER_MODE=mock-llm` refuses to start with a message saying
  why, and that an unset `WORKER_MODE` fails loudly.
- **PR 4** — `pnpm test:playwright`, since the fixtures the specs share are what the deletion must
  not touch.
- **PR 5** — `pnpm test:system`, run **more than once**: a single green run does not prove a suite
  that spawns a worker and shares Mailpit is free of races. Check `uptime` first so a loaded machine
  is not misread as a flake.

## Key files

| File | Change |
| --- | --- |
| `python/worker_child/src/worker_child/testing.py` | **new** — scenario catalogue, `build_analyze`, `main` |
| `pyproject.toml` | `per-file-ignores` for `**/testing.py` |
| `packages/browser-testing/` | **new** — `advancePoll`, `advanceThroughPollFailures`, `ensureHydrated` |
| `apps/web/e2e/lib/fake-poll.ts`, `hydration.ts` | shrink to re-exports |
| `apps/worker/src/modes.ts`, `modes.test.ts` | **new** — `resolveWorkerMode(env)` |
| `apps/worker/src/main.ts` | read `WORKER_MODE`, drop the inline `childCommand` |
| `apps/worker/package.json` | `dev` runs the worker |
| `.env.example`, `.env.test`, `turbo.json` | `WORKER_MODE`; fix `PYTHON_BIN` |
| `apps/web/scripts/seed-reports.ts` | **deleted**, with its turbo task and root script |
| `tests/e2e/` | **new package** — `package.json`, `playwright.config.ts`, `scripts/test-run.ts`, two specs, README |
| `turbo.json`, root `package.json` | `test:system` task and script |
| `apps/worker/README.md`, root `README.md` | modes, scenarios, running it locally |

Unchanged by design: `apps/worker/src/testing/fake-child.ts`, `python/worker_child/tests/support/child.py`,
`worker_child/run.py`, `worker_child/__main__.py`, `contract/`, `apps/web/e2e/fixtures/reports.ts`,
`apps/web/src/lib/reports/limits.ts`, and every route in `apps/web`.
