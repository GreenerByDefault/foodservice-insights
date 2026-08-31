# Test suite flakes

## Context

`pnpm test` intermittently fails on specs that pass on an immediate rerun. `playwright.config.ts`
sets `retries: 0`, and AGENTS.md § Verifying a change makes the full suite the gate before anyone
can say a change works — so one flake costs a full re-run of a ~97s suite, and worse, it trains
whoever hit it to re-run rather than read. The sightings below, on different branches in
different sessions, agree on enough to be worth chasing.

### Sighting 1 — `main` @ 7e299ac, clean tree

The first `pnpm test:e2e` of the session — run immediately after `pnpm test:unit`, which is the
ordering `pnpm test` always uses — failed 5 of 25 in 1m6s:

- `e2e/layout.e2e.ts:36` — `/ has no horizontal overflow at any viewport`
- `e2e/layout.e2e.ts:36` — `/sign-in has no horizontal overflow at any viewport`
- `e2e/reports/cancel.e2e.ts:14` — canceling from the waiting screen
- `e2e/reports/retry.e2e.ts:19` — retrying a failed report
- `e2e/reports/retry.e2e.ts:62` — a report at the attempt cap has no retry button

An immediate standalone rerun passed 25/25 in 41.3s. Nothing was listening on 4173 beforehand, so
`reuseExistingServer` had no stale server to reuse.

### Sighting 2 — `report-page-cleanup` @ 158c3a6, 2026-08-30

Seen while landing a pure reorganization of the report-page route (file moves plus three
component extractions). The screenshot project passed with byte-identical images throughout, which
is what rules the code change out as the cause.

- **Run A** (`pnpm test`): `waiting/cancel-button.svelte.test.ts` failed 1 of its 5 tests, and the
  file took **103,325ms**. That is the `client` unit project, not e2e. An isolated rerun passed
  690/690.
- **Run B** (`pnpm test`): `e2e/reports/cancel.e2e.ts:14` failed —
  `getByText('Someone stopped this report')` never became visible, 5000ms timeout, "element(s) not
  found". The component test asserting that same copy passed in the same run.
- `cancel.e2e.ts` alone, three consecutive runs: passed at **34.7s, 12.7s, 19.8s**.
- **Run C** (`pnpm test`): fully green — 690 unit, 25 e2e, 16 screenshots.

### Sighting 3 — `fix-component-cleanup` @ b100563, 2026-08-30

Three failures on an otherwise-idle machine, all in the `client` project, all while *timing* that
tier rather than changing it. **Three of four consecutive `pnpm test` runs failed**, which makes
this the first sighting dense enough to chase without a harness.

> **Correction (2026-08-30).** The machine was not idle. This session left 12 `yes` processes
> running on all 8 cores, and they were still running six hours later. Every number below — the
> timings, the concurrency table, and the Lead 0 measurements they fed — was taken under that
> load. See lead 0.

- Roughly 25 consecutive `client`-only runs produced one failure, of 1 file in 11. The file's
  name was not captured.
- `pnpm test`: `failure-view.svelte.test.ts:138` — *while the request is in flight, the retry
  button is disabled*.
- The very next `pnpm test`: `waiting/cancel-button.svelte.test.ts:20` — *opens a confirming
  dialog, and "Keep it running" closes it without calling the endpoint*. Sighting 2's file again.

Both named failures are `Error: Test timed out in 15000ms`, reported against the `test(` line
with **no assertion error** — an `await` that never settled, not a wrong value. The other four
tests in the cancel-button file passed in 100-254ms each, in the same run.

**The clock is the tell.** That cancel-button test is reported at **42,700ms — nearly 3× its own
15,000ms timeout** (and its file at 43,388ms). A test cannot overrun its timeout by 28 seconds
while the timer is running. The tester page was *stalled*, not slow, and the timeout only fired
once it came back. Sighting 2's 103,325ms file is the same shape, larger.

**It needs the rest of the workspace running.** Narrowing by how much else runs alongside:

| What was run | Concurrency | Failures |
| --- | --- | --- |
| `vitest run --project=client` alone | 11 browser files | 0 of 6 |
| `vitest run` in `apps/web` (both projects) | + 52 node files | 0 of 3 |
| `pnpm test` (`turbo run test:unit`) | + 5 other packages' suites | **3 of 4** |

Only the last one fails, and it failed three times before going green — so the trigger is load
*outside* `apps/web`, not anything the browser tier does to itself. That also explains why every
isolated rerun in sightings 1 and 2 passed. Lead 0 is the mechanism this points at; the missing
step is whether starving the browser of CPU is enough to stall it for 28 seconds, or whether the
contention is for something more specific.

### What the sightings say together

1. **`cancel.e2e.ts:14` and `retry.e2e.ts` appear in both e2e sightings.** The report-page action
   specs — the ones that click through a dialog, POST, and wait for the page to converge — are the
   highest-signal place to start.
2. **This is not e2e-only.** `cancel-button.svelte.test.ts` is a Chromium component test with no
   Playwright webServer and no database anywhere near it. Any theory scoped to the e2e stack alone
   does not cover sighting 2, and a fix validated only against e2e will look like it worked.
3. **The timing variance is itself the symptom.** 12.7s–34.7s for the same isolated spec file, 103s
   for a unit file that normally takes seconds, 1m6s against 41.3s for the same e2e suite. Something
   is waiting, not computing — and sighting 3 shows a test overrunning its own timeout by 28
   seconds, which narrows "waiting" to *stalled*. See lead 0.
4. **Every failure is "the element never appeared", never a wrong value.** Consistent with a lost or
   delayed update, not with broken assertion logic.

### Leads, strongest first

0. ~~**Chromium itself stalls on this machine, for tens of seconds at a time.**~~ **Refuted
   2026-08-30.** The stall is real but it was not Chromium's: the machine was pegged by **12
   orphaned `yes` processes**, started 15:40 on 2026-08-30 and still running six hours later —
   spawned by sighting 3's own session to test whether CPU starvation could stall the browser, and
   never cleaned up. Every Lead 0 measurement was taken under that load.

   With the load gone and *nothing else changed*, `chromium.launch()` / `close()` over 12
   iterations:

   | Condition | close median | close max |
   | --- | --- | --- |
   | 12 `yes` processes running | 2,295ms | 22,258ms |
   | same, `renice +20` | 5,566ms | 9,697ms |
   | quiet machine | **31ms** | **83ms** |

   Chromium's exit is ~31ms. The "1.5s to the 30s force-kill cap" distribution was the load
   generator. Corroborating detail gathered before the load was lifted: during an 18s stall the
   process accrued **zero user CPU** while marked runnable, and `sample` returned an **empty call
   graph** — it had no threads left to sample. That is a process starved of CPU in its exit path,
   not one blocked on IPC, which is why no Chromium flag moved it. Build 1228 and build 1234
   stalled identically under the load and neither stalls without it, so the version question is
   moot. Memory pressure is *not* the cause either: swap was still at 7.3GB of 8GB during the
   31ms measurements.

   The consequence is wider than one lead: **sighting 3's "otherwise-idle machine" was not idle**,
   so its client-tier timeouts (`failure-view.svelte.test.ts:138`,
   `waiting/cancel-button.svelte.test.ts:20`) are explained by the same starvation — including the
   42,700ms overrun of a 15,000ms timeout, which is what a stalled tester page looks like. Its
   concurrency table measured how much CPU each configuration wanted while 12 hogs held all 8
   cores, not anything about the tiers.

   *Before trusting any timing measurement here, check `pgrep -x yes` and `uptime`.*

1. **The single test Supabase stack is shared across every git worktree — confirmed, and
   reproducible on demand.** `.env.test` hardcodes `DB_CONNECTION_STRING=…@127.0.0.1:65322`, and
   `scripts/supabase` brings up one Docker project from `supabase-test/`. There are currently
   **four worktrees** (`foodservice-insights`, `.upload-form`, `.view-report`, `.visual-testing`),
   each with its own session, and all four resolve to that one database. The Playwright
   `webServer` command runs `truncate && migrate && seed:identity` for *its* run; any other
   worktree starting its suite runs the same `truncate` and deletes the rows out from under a run
   already in flight.

   Observed in a real run (1 of 4 uncached `pnpm test` runs on the now-quiet machine): the log
   shows `seed:identity: seeded the placeholder user`, then `Listening on http://0.0.0.0:4173`,
   then every request failing with `Identified user 00000000-…-000000000001 has no row in the
   database`. 11 specs failed on HTTP 500s. Nothing in that run truncated after seeding.

   Reproduced deliberately: start `test:e2e` in one worktree, run
   `TEST_DB=1 pnpm --filter @gbd/db run truncate` from another the moment the first test starts →
   **9 failed**, among them `retry.e2e.ts:19` and `layout.e2e.ts:50` — the specs sightings 1 and 2
   both named. Timing matters: fire the truncate during boot instead and the run passes, which is
   why this is intermittent rather than constant.

   This subsumes the old leads 1 and 2. The contention is *between worktrees*, not between the
   tiers of one run, so a barrier inside a single `pnpm test` would not have touched it.

2. **The `derived_inert` warning — unverified, but cheap to check.** Every client unit
   run logs `[svelte] derived_inert — Reading a derived belonging to a now-destroyed effect may
   result in stale values`. Nothing has traced it to a component. It is worth doing, because a
   stale value read off a destroyed effect is exactly the shape of "the expected text never
   appeared", and `report-view.svelte` holds a writable `$derived` (`let current = $derived(data)`)
   that the poll writes through. If the warning originates there it may explain the unit-tier flake
   and possibly the e2e one. Treat as a hypothesis with no evidence behind it yet.

### Reproduce before fixing

**Both halves now reproduce, and one is deterministic.**

The e2e half fires on demand (lead 1). In one worktree, start `TEST_DB=1 pnpm --filter @gbd/web
run test:e2e`; the moment its first test reports, run `TEST_DB=1 pnpm --filter @gbd/db run
truncate` from a *different* worktree. That produced **9 failures**, including `retry.e2e.ts:19`
and `layout.e2e.ts:50`. Fire the truncate earlier, during webServer boot, and the run passes —
the window is the test phase only, which is the whole reason this presents as a flake.

The unit half no longer reproduces once the machine is quiet, consistent with lead 0 being the
whole of it. Four uncached `pnpm test` runs on the quiet machine: **one failure, and it was the
e2e/database one** (11 specs, all HTTP 500 on `Identified user … has no row in the database`),
not a client-tier timeout. Suite wall clock also fell from ~97s to 46-70s.

CI is the control and it is clean: no instance of either signature across ~100 Linux runs. The
two real failures there were an already-fixed Supabase Storage flake and an unrelated Python one.
So this is local-macOS-only and, on current evidence, entirely about how this machine is being
shared.

## PR 1 — Skipped: no repro harness

Considered and rejected. A generic "run `pnpm test` N times, report the rate" tool answers a
question sighting 3 already answered by hand — 3 of 4 runs failing is dense enough to watch
directly — and would not have found Lead 0, which came from targeted instrumentation of
Chromium's own launch/close behavior, not from counting suite-level pass/fail. Building it now
would be tooling in search of a use, not tooling a lead is waiting on.

Still the right call, though not for the reason given: Lead 0 turned out to be an artifact of the
very instrumentation that session left running, and the cause that survived (lead 1) reproduces
deterministically. A pass/fail counter would have found neither.

## PR 2 — Give each worktree its own test data

**Confirmed by the author:** they were running `pnpm test` in another worktree and stopped it
mid-run, and they *frequently run several Claude Code sessions at once*. That is the workflow this
repo has to support, not an accident to be avoided — so "don't run two suites at once" is not an
acceptable answer, and neither is anything that only orders the tiers *within* one run.

The contended state is everything the Playwright `webServer` command resets: `pnpm -r run
truncate` empties 32 Postgres tables, the mailbox, and the blob store (60 objects in the observed
run), and `seed:identity` recreates the placeholder user every other worktree's server is
authenticating as. All of it is addressed by one hardcoded line — `.env.test`'s
`DB_CONNECTION_STRING=…@127.0.0.1:65322/postgres`.

Options, cheapest first:

1. **A machine-wide lock around the suite.** A lockfile every `test:playwright` acquires, so a
   second worktree's run waits rather than interleaves. Simplest thing that works, no schema or
   infrastructure change, and honest about the fact that this 8-core machine cannot usefully run
   two suites at once anyway. Cost: a session blocks for the length of another's suite, with no
   signal about why unless the wait prints one.
2. **A per-worktree database inside the one Postgres** (recommended for the real fix). Derive the
   database name from the worktree path — `postgres` becomes e.g. `fsi_test_<short-hash>` — and
   give the blob store a matching per-worktree bucket or key prefix, since `packages/storage`'s
   truncate is just as destructive. Real isolation, one Docker stack, and concurrent sessions stop
   interfering entirely. Cost: `migrate` must create the database on demand, and stale databases
   accumulate as worktrees come and go.
3. ~~A per-worktree Supabase stack.~~ Rejected: the test stack is 14 containers and the machine
   already runs two stacks against 16GB of RAM with 7GB swapped. Multiplying that by the number
   of live worktrees would make the memory problem worse than the flake.

Reproduce with the deterministic recipe in "Reproduce before fixing" — it must stop failing after
the change, and that is a yes/no, not a rate.

## PR 3 — Trace the `derived_inert` warning

Independent of the other two and worth doing regardless, since the warning is noise in every unit
run whether or not it turns out to be the flake. Find the component it comes from. If it is
`report-view.svelte`'s writable `$derived`, decide whether that is a real stale-read or a benign
teardown warning, and either fix it or suppress it at the source with a comment saying why it is
benign.

**Decided: no `retries: 1`.** The stopgap was being held until Lead 0 was understood; it now is.
Neither surviving cause is the kind of flake a retry is for. A run whose database was truncated by
another session does not deserve a second attempt — it deserves isolation — and a retry would
convert a loud, diagnosable wipe into a quiet "flaky" label. Revisit only if a genuinely
nondeterministic failure shows up that isn't explained by PR 2 or by machine load.

## Follow-ups this work identifies but does not do

- **The `test:unit` → `test:e2e` ordering is implicit.** `pnpm test` always runs them in that
  order, but nothing declares or enforces it. No longer load-bearing for any lead — the contention
  turned out to be between worktrees, not between tiers — so this is now tidiness rather than a
  dependency of the fix.
- **Nothing cleans up a session's own load generators.** Sighting 3's `yes` processes outlived
  their experiment by six hours and invalidated every measurement taken afterwards, including this
  plan's former strongest lead. Whatever spawns background load for a measurement should kill it
  in the same breath.

## Verification

The test stack must be running: `TEST_DB=1 scripts/supabase start`.

1. From the repo root: `pnpm lint && pnpm check && pnpm test`.
2. Run the cross-worktree recipe in "Reproduce before fixing" before and after PR 2. It fails
   deterministically today, so this is a yes/no rather than a rate, and a single green `pnpm test`
   proves nothing — every sighting so far was followed by one.
3. Check `pgrep -x yes` and `uptime` first. Any timing taken on a loaded machine is worthless, as
   lead 0 shows.
4. Say plainly if the flake could not be reproduced. "Could not reproduce" is a real and useful
   result here; a silent fix is not.
