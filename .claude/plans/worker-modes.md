# Worker modes: running the whole lifecycle locally

## Context

`pnpm dev` used to start only the web app and five `tsc --watch` processes, so a report uploaded in
dev sat `pending` forever: the upload form and the rejection view were reachable by hand, but never
the waiting screen's transitions, the result screen arriving, a failure arriving, Cancel racing a
live child, or the result email — those states were reachable only by writing rows directly with a
Playwright fixture inside a test. Tests are not a substitute for a human watching the thing behave,
especially for how it looks mid-transition and on a small screen.

The blocker was assumed to be the Python port. It wasn't. `python/worker_child` is **complete and
working**; only `gbd_foodservice_insights.analyze()` raises `NotImplementedError`. And
`worker_child.run.run()` already took an injectable `analyze`, while
`gbd_foodservice_insights.testing.stub_analysis` already shipped an `analyze` that writes real
PDF/xlsx magic bytes and raises each failure type on demand. The whole lifecycle was one entrypoint
and one env var away — and now `WORKER_MODE` in `.env` picks how the analysis is faked, `pnpm dev`
runs a worker in that mode, and a dev drives scenarios by naming the report `!hang`, `!slow:90`,
`!fail:unusable-data`, and so on (see § The scenario travels in the report name).

**Left to do:** the report page polls at production's cadence even in `stubbed` mode, which slows
down watching a scenario play out by eye; and `tests/e2e` is still a README instead of a real
suite.

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

### Playwright helpers live in `@gbd/browser-testing`

`packages/browser-testing/` carries the Playwright helpers both e2e suites need: `advancePoll`
and `advanceThroughPollFailures` drive a page's poll loop through Playwright's fake clock instead
of waiting out real intervals, and `ensureHydrated` waits for Svelte's client runtime before a
test interacts with the page. `apps/web` takes it as a `devDependency` (test-only, so not a
`dependency`) and its e2e specs import all three directly.

The one thing that stays local to each suite is the poll interval itself — a UI polling cadence
doesn't belong in a shared package. `apps/web/e2e/lib/poll-interval.ts` re-exports
`BASE_POLL_INTERVAL_MS` from a deep `apps/web` route path; `tests/e2e` cannot reach across the
package boundary to reuse that re-export, so it keeps its own local constant, with a comment that
it must exceed the app's poll interval. The drift risk is one number that only ever makes a test
slower.

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

Two PRs left. `REPORT_RATE_LIMIT=off`, the stubbed Python child (`worker_child/testing.py`,
`build_analyze`, the scenario catalogue), and the mode switch itself have all landed: `WORKER_MODE`
picks the child `apps/worker/src/modes.ts`'s `resolveWorkerMode` resolves to (`stubbed` runs
`worker_child.testing`, `live` the real module, `mock-llm` fails loudly naming the port as the slot
it fills, `off` starts no worker), `PYTHON_BIN` is anchored to the repo root by
`apps/worker/src/python-bin.ts` since pnpm and `spawnChild` both run from directories that aren't
it, and `pnpm dev` now runs the worker under `node --watch`. PR 1 below is the faster polling; PR 2
needs PR 1 landed first (see its note on why).

## PR 1 — the web app polls faster too, driven by `WORKER_MODE`

The report page polls at a flat `BASE_POLL_INTERVAL_MS` (10s) no matter the mode — even `stubbed`,
where nothing is real and there's no contention to be gentle about, sits on the same 10s ticks
production would. That makes walking the scenario catalogue by eye slower than it needs to be.
It's orthogonal to system-e2e speed: PR 2's tests drive `page.clock` directly through
`advancePoll`/`advanceThroughPollFailures`, so the real interval's value never touches their
wall-clock time either way. This PR is purely for the human watching the screen.

`schedule.ts`'s `BASE_POLL_INTERVAL_MS` is a browser-side module constant, imported straight into
`report-view.svelte` — and browser code can't read `$env/dynamic/private` itself. So the value has
to be resolved server-side and threaded down, the same shape `REPORT_RATE_LIMIT=off` already uses:
`+page.server.ts` reads `WORKER_MODE` (inside the load function, not module scope — same reasoning
as `checkReportRateLimit`), adds a `pollIntervalMs` field to `ReportPageData`, and `nextPollDelayMs`
takes it as a parameter instead of importing a constant. `stubbed` gets a fast interval (in the
neighborhood of the worker's own `stubbed` profile, e.g. 1s); `mock-llm`, `live`, and `off` keep the
current 10s — `mock-llm` is meant to feel like production, cadence included, so it doesn't get the
fast profile `stubbed` does, matching `apps/worker/src/modes.ts`'s own reasoning for
`STUBBED_OVERRIDES`.

Touches `polling/schedule.ts`, `polling/schedule.test.ts`, `+page.server.ts`, `report-view.svelte`,
and `report-view.svelte.test.ts`. `apps/web/e2e/lib/poll-interval.ts` changes from a static
re-export of `BASE_POLL_INTERVAL_MS` to something that resolves the interval the same way the
server does, since it's no longer a plain constant — this is why PR 2 wants this PR landed first,
so `tests/e2e`'s own hardcoded poll constant (see § Playwright helpers live in
`@gbd/browser-testing`) is written against the real fast value from the start instead of being
retrofitted.

## PR 2 — `tests/e2e` becomes `@gbd/e2e`

CI is already waiting: `.github/workflows/ci.yml`'s `system-e2e` job runs `turbo run test:system`,
gated on `tests/e2e/package.json` existing, and `.github/filters.yml` already has a `system` filter.
Missing: the package, the turbo task, a root script, a Playwright config, and a run script.

Leave `no-reload.ts`, `layout.ts`, and `viewports.ts` in `apps/web/e2e/lib/` — move them only if this
suite turns out to want them, not speculatively.

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
`advancePoll`'s doc comment explains. The scenarios are chosen to finish immediately: the happy path
is a plain report name, not `!slow`.

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

- **PR 1** — `pnpm dev` with `WORKER_MODE=stubbed`, watch the report page poll noticeably faster
  than 10s; confirm `WORKER_MODE=mock-llm`/`live`/`off` still poll at the old cadence. Confirm
  `schedule.test.ts` and `report-view.svelte.test.ts` pass with the interval now a parameter, not
  an import.
- **PR 2** — `pnpm test:system`, run **more than once**: a single green run does not prove a suite
  that spawns a worker and shares Mailpit is free of races. Check `uptime` first so a loaded machine
  is not misread as a flake.

## Key files

| File | Change |
| --- | --- |
| report route's `polling/schedule.ts`, `+page.server.ts`, `report-view.svelte` | poll interval driven by `WORKER_MODE` |
| `apps/web/e2e/lib/poll-interval.ts` | resolves the interval instead of re-exporting a constant |
| `tests/e2e/` | **new package** — `package.json`, `playwright.config.ts`, `scripts/test-run.ts`, two specs, README |
| `turbo.json`, root `package.json` | `test:system` task and script |

Unchanged by design: `apps/worker/src/testing/fake-child.ts`, `python/worker_child/tests/support/child.py`,
`worker_child/run.py`, `worker_child/__main__.py`, `contract/`, `apps/web/e2e/fixtures/reports.ts`,
`apps/web/src/lib/reports/limits.ts`, and every other route in `apps/web`. Already landed:
`python/worker_child/src/worker_child/testing.py` and its `pyproject.toml` `per-file-ignores` entry,
and the mode switch itself — `apps/worker/src/modes.ts`, `python-bin.ts`, `main.ts`, `.env.example`/
`.env.test`/`turbo.json`'s `WORKER_MODE`, and `pnpm dev` running the worker.
