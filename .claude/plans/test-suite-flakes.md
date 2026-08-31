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
tier rather than changing it. **Two consecutive `pnpm test` runs failed**, which makes this the
first sighting dense enough to chase without a harness.

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
| `pnpm test` (`turbo run test:unit`) | + 5 other packages' suites | **3 of 3** |

Only the last one fails, and it fails every time — so the trigger is load *outside* `apps/web`,
not anything the browser tier does to itself. That also explains why every isolated rerun in
sightings 1 and 2 passed. Lead 0 is the mechanism this points at; the missing step is whether
starving the browser of CPU is enough to stall it for 28 seconds, or whether the contention is
for something more specific.

### What the sightings say together

1. **`cancel.e2e.ts:14` and `retry.e2e.ts` appear in both e2e sightings.** The report-page action specs — the
   ones that click through a dialog, POST, and wait for the page to converge — are the highest-signal
   place to start.
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

0. **Chromium itself stalls on this machine, for tens of seconds at a time.** Measured
   independently while timing the `client` tier: `chrome-headless-shell` takes anywhere from 1.5s
   to Playwright's 30s force-kill cap to exit after `Browser.close`, with every thread idle in
   `mach_msg` — and a bare `chromium.launch()` then `close()`, no page ever loaded, reproduces the
   same distribution. That exit wait cannot itself explain any of the failures, because it happens
   after the results are printed. What makes it a lead is that it is the *same signature* in the
   same binary: seconds-long idle stalls, no work being done. If one cause produces both, every
   symptom here follows — the timeouts, the 100s test file, the e2e "element never appeared", the
   variance — and no amount of test-side isolation will touch it. Cheap first checks: does the
   rate change on a different Chromium version, or on CI's Linux runners? A flake that is
   local-macOS-only is a very different problem from one that ships.
   *Rejected as a fix: nothing in the tests' control moves it — `browser.isolate`, file count,
   `--disable-gpu`, `--no-zygote`, `--in-process-gpu` and the full `chromium` channel were all
   measured and none changed the distribution.*

1. **The shared test Supabase stack, with nothing making one tier quiesce before the next.**
   `apps/web/e2e/setup/database.setup.ts` clears fixture reports as a barrier before either
   Playwright project starts, and the `webServer` command runs `truncate && migrate &&
   seed:identity` ahead of that. Both guarantee a clean *start*; neither makes the preceding
   `test:unit` run's database and blob-store work finish first.
2. **`fullyParallel: true` against one shared fixture organization.** `e2e/layout.e2e.ts:43` already
   documents a live instance of this — it uses the `failed-retried` state rather than `failed`
   precisely because `failed`'s fixture "pins a fixed creator email for a committed screenshot,
   which collides with retry.e2e.ts's own 'failed' fixture when both run concurrently." One such
   collision is documented and worked around; the barrier does nothing about collisions *during* a
   run.
3. **The `derived_inert` warning — unverified, but cheap to check.** Every client unit
   run logs `[svelte] derived_inert — Reading a derived belonging to a now-destroyed effect may
   result in stale values`. Nothing has traced it to a component. It is worth doing, because a
   stale value read off a destroyed effect is exactly the shape of "the expected text never
   appeared", and `report-view.svelte` holds a writable `$derived` (`let current = $derived(data)`)
   that the poll writes through. If the warning originates there it may explain the unit-tier flake
   and possibly the e2e one. Treat as a hypothesis with no evidence behind it yet.

### Reproduce before fixing

A fix aimed at the wrong cause is indistinguishable from the flake going quiet on its own, and
sightings 1 and 2 went green on the very next run. So nothing here gets fixed until it can be
made to fail on demand.

Sighting 3 may have removed the need for a harness to get there: two consecutive `pnpm test` runs
failed, which is a rate you can watch directly. Check whether that still holds before building one.

- For the cross-tier theory: `pnpm test:unit && pnpm test:e2e` in a loop.
- For the unit-tier flake: the `client` project alone in a loop, which sighting 2 shows is enough
  and which is far cheaper per iteration.

Record the observed failure rate. A flake that reproduces at 1-in-20 needs a different fix strategy
than one that reproduces at 1-in-3.

## PR 1 — A repro harness

A script that runs a chosen sequence N times and reports the failure rate and per-run wall time,
so the next session does not re-derive it by hand and so PR 2 and PR 3 have a before/after number.
Should cover both loops named above.

Keep it a local script, not a CI job — this exists to be run deliberately while chasing a cause.

## PR 2 — Isolate the shared state the tiers contend on

Conditional on PR 1 producing a reproduction. Depending on what it shows, the candidates are:
making `test:unit` wait for its database and blob-store work to settle before `test:e2e` starts,
giving the tiers separate stacks, or giving concurrent specs non-colliding fixtures rather than one
shared placeholder organization.

Pick the fix the reproduction actually points at, and re-run the harness to show the rate moved.
Do not fix all three speculatively.

## PR 3 — Trace the `derived_inert` warning

Independent of the other two and worth doing regardless, since the warning is noise in every unit
run whether or not it turns out to be the flake. Find the component it comes from. If it is
`report-view.svelte`'s writable `$derived`, decide whether that is a real stale-read or a benign
teardown warning, and either fix it or suppress it at the source with a comment saying why it is
benign.

**Open:** whether to set `retries: 1` in `playwright.config.ts` as a stopgap. It would stop flakes
from failing the gate, and Playwright marks retried passes as flaky rather than hiding them. But it
also doubles the cost of a genuine failure and removes the pressure that produced this plan. Worth
deciding explicitly rather than drifting into either answer — and if it goes in, it should go in
*after* PR 1, so the harness can still measure the underlying rate.

## Follow-ups this work identifies but does not do

- **The `test:unit` → `test:e2e` ordering is implicit.** `pnpm test` always runs them in that order
  and lead 1 depends on it, but nothing declares or enforces it. If the fix turns out to depend on
  ordering, that dependency should become explicit in `turbo.json` rather than emergent.

## Verification

The test stack must be running: `TEST_DB=1 scripts/supabase start`.

1. From the repo root: `pnpm lint && pnpm check && pnpm test`.
2. Run the PR 1 harness enough times to state a failure rate with a straight face, before and after
   whatever PR 2 changes. A single green `pnpm test` is not evidence — every sighting so far was
   followed by one.
3. Say plainly if the flake could not be reproduced. "Could not reproduce" is a real and useful
   result here; a silent fix is not.
