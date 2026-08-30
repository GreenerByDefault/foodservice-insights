# Test suite speed and flakes

## Context

`pnpm test` takes ~107s locally after a typical change, and AGENTS.md § Verifying a change makes
that the gate before any agent can say a change works. The suite's rigor is not in question — it
has been through `/test-rigor` repeatedly and the tests earn their keep. What follows is about
paying for that rigor only when it can tell us something.

Measured on `main` @ 7e299ac, macOS, warm caches, clean tree:

| Step | Nothing changed | After a web change |
| --- | --- | --- |
| `pnpm lint` | 1.0s | 1.0s |
| `pnpm check` | 1.1s (FULL TURBO) | ~15s |
| `pnpm test:unit` | 1.5s (FULL TURBO) | ~30s |
| `pnpm test:e2e` | **42s — always** | 42s |
| `pnpm test:screenshots` | **35s — always** | 35s |
| **`pnpm test`** | **~78s floor** | **~107s** |

Turbo is doing its job: `check` and `test:unit` collapse to ~2.6s combined when untouched. The
finding is that `turbo.json` marks `test:e2e` and `test:screenshots` `cache: false`, so **77 of
the ~107 seconds go to two tasks Turbo is structurally forbidden from skipping** — including on a
Markdown-only edit. This is not a missing build system; it is two opted-out tasks.

Where the time inside them goes, all measured rather than inferred:

- **10.0s of the 35s screenshot run is the oxipng teardown**, re-optimizing 12 already-optimized
  PNGs that the run never wrote. `optimize-screenshots.teardown.ts` skips only when
  `updateSnapshots === 'none'`, which is CI-only, so this is pure local waste.
- **e2e and screenshots each boot the app separately** — truncate + migrate + seed +
  adapter-node, twice per `pnpm test`.
- **8.4s of the 11s server unit project is two tests** in
  `apps/web/src/lib/reports/csv/normalize.test.ts`, each materializing a 500,001-row CSV string.
- The `client` project is ~34s wall standalone against 12.4s of reported test duration; the gap
  is Chromium + Vite startup for 43 component tests. No cheap fix that keeps the real browser.
- **A README edit invalidates `test:unit`** — confirmed by a hash flip from `HIT` to `MISS`.
  `build` excludes `**/*.md`; `check` and `test:unit` do not. `.github/filters.yml` already
  excludes `*.md` and `.claude/**` from the `ts` filter, so CI and Turbo disagree.
- **The Turbo daemon is a dead end — do not recommend it.** It is not running and does not
  auto-start, which looks like a missed optimization and is not one: `turbo.json`'s schema marks
  the `daemon` option deprecated, "no longer used for `turbo run`", and slated for removal in
  Turbo 3.0. It serves `turbo watch` only. Measured to be sure — 6 fully-cached `turbo run check`
  invocations with the daemon running (1.06-1.45s) against 6 with it stopped (1.07-1.43s). The
  apparent win on first measurement was filesystem warming; both series plateau at ~1.1s.

### The AGENTS.md question, and why the answer is no

The tempting change is to tell agents to right-size test validation to the change. Rejected:

- Blast-radius reasoning is what an agent is worst at and Turbo is best at. Fixing the caching
  makes the tool right-size correctly and automatically; prose makes the agent guess, and the
  failure mode is silent — it skips e2e for a change that breaks e2e, and CI finds out.
- "Right-size it" reads as a licence to skip. Once it is in AGENTS.md, "I only changed a
  comment" becomes defensible, and the agentic loop that makes agents useful here is lost.

What replaces it is a loop-versus-gate distinction, which needs no judgement call, plus running
the gate in the background. See PR 5.

## PR 1 — Skip the screenshot optimizer when the run wrote nothing

`apps/web/e2e/setup/optimize-screenshots.teardown.ts` currently returns early only for
`updateSnapshots === 'none'`. Widen that to "nothing was written": consult the run's result for
whether any snapshot was added, and skip `optimizeScreenshots()` otherwise. A plain
`test:screenshots` against committed images writes nothing, so this is the common local case.

Keep the behaviour the existing comment describes — a raw `playwright test --project=screenshots
--update-snapshots` must still end up optimized. The guard is on *wrote something*, not on which
script invoked it.

Worth −10s from every local `test:screenshots`. No effect in CI, which already skips it.

## PR 2 — Exclude Markdown from `check` and `test:unit` inputs

In `turbo.json`, give both tasks the same `inputs` treatment `build` already has:

```json
"inputs": ["$TURBO_DEFAULT$", "!**/*.md"]
```

Editing a package README stops invalidating that package's typecheck and unit tests. Verify the
same way this was found: `turbo run test:unit --dry=json` before and after appending a line to
`apps/web/README.md`, and check the hash no longer moves.

## PR 3 — Make `test:e2e` and `test:screenshots` cacheable

The one that matters: −77s whenever a change provably cannot reach them.

Both tasks are `cache: false` in `turbo.json`. Their real inputs are already in the graph —
`test:e2e` depends on `build`, which depends on `^build`, so `packages/db` migrations and every
other package's source are transitively hashed. Turn caching on, keeping the existing `outputs`
so reports and results are restored on a hit.

Two things to settle in the PR rather than assume:

- **A cache hit skips the truncate/migrate/seed** that the Playwright `webServer` command runs,
  so the test database keeps whatever state it had. That is fine for the tests themselves — they
  did not run — but it changes what a developer finds if they then poke at the stack by hand.
  Decide whether that is acceptable or whether the seeding should move somewhere the cache does
  not cover.
- **Locally, `updateSnapshots: 'missing'` writes into the source tree**, mutating an input. With
  PR 1 landed that only happens when a snapshot is genuinely new, which is a real change and
  *should* miss the cache next run. Confirm that is what happens.

If full caching turns out to be too loose, the fallback is running `--affected` locally, exactly
as CI already does via `TURBO_SCOPE`. That is strictly weaker — it depends on git state — so
prefer caching and keep this in reserve.

## PR 4 — Stop building 500k-row CSVs in two unit tests

`apps/web/src/lib/reports/csv/normalize.test.ts:90` and `:99` each fill an array of
`MAX_DATA_ROWS + 1` rows and join it, costing 4.8s and 3.5s — 8.4s of an 11s project.

Make the row cap injectable through `normalizeCsv`'s options so those two tests pass a small cap,
and add one test asserting the production default is wired to `MAX_DATA_ROWS`. Same assertions,
same branches covered, ~8s cheaper. This is a test-cost change, not a rigor change; if the
injectable cap cannot be made to read cleanly, leave the tests alone and say so.

## PR 5 — AGENTS.md: separate the iteration loop from the gate

Keep `pnpm lint && pnpm check && pnpm test` as the definition of done, verbatim. Add two things
to § Verifying a change:

- **During iteration**, scope to the package under change: `pnpm --filter @gbd/<pkg> test:unit`.
  The full command stays the gate before claiming a change works. This is a loop-versus-gate
  rule, not a judgement about what a change can affect.
- **Run the gate in the background.** Claude Code's Bash tool takes `run_in_background: true` and
  notifies on completion, so the suite runs while the agent re-reads its own diff, runs
  `/prune-comments`, and drafts the PR body. This recovers most of the wall clock at no cost to
  rigor and is currently unused.

Leave "Report what you actually ran" exactly as it is — it is what keeps the scoped loop honest.

## PR 6 — The e2e flakes

Independently pickup-able; nothing above depends on it. Worth doing first if the goal is agent
wall-clock, because with `retries: 0` a single flake costs an agent more minutes than every
caching win here combined.

Observed on `main` @ 7e299ac, clean tree. The first `pnpm test:e2e` of the session — run
immediately after `pnpm test:unit`, which is the ordering `pnpm test` always uses — failed 5 of
25 in 1m6s:

- `e2e/layout.e2e.ts:36` — `/ has no horizontal overflow at any viewport`
- `e2e/layout.e2e.ts:36` — `/sign-in has no horizontal overflow at any viewport`
- `e2e/reports/cancel.e2e.ts:14` — canceling from the waiting screen
- `e2e/reports/retry.e2e.ts:19` — retrying a failed report
- `e2e/reports/retry.e2e.ts:62` — a report at the attempt cap has no retry button

An immediate standalone rerun passed 25/25 in 41.3s. Nothing was listening on 4173 beforehand, so
`reuseExistingServer` had no stale server to reuse.

The 1m6s-versus-41.3s gap alongside the failures points at contention or leftover state rather
than a logic bug. First suspect is the preceding `test:unit` run against the same test Supabase
stack: `apps/web/e2e/setup/database.setup.ts` clears fixture reports as a barrier before either
suite starts, but nothing makes `test:unit`'s blob-store and database work quiesce first.
`layout.e2e.ts` already carries a comment about fixture collision between concurrent specs, so
shared fixture state is the thing to read first.

Not yet reproduced deliberately. Reproduce before fixing — `pnpm test:unit && pnpm test:e2e` in a
loop — because a fix for the wrong cause here is indistinguishable from the flake going quiet.

## Follow-ups this work identifies but does not do

- **One Playwright invocation for both projects.** `test:e2e` and `test:screenshots` boot the app
  separately; they are already two projects in one config, so `playwright test --project=e2e
  --project=screenshots` would boot once. This must stay a local convenience script and not
  replace the two tasks, because CI deliberately splits them across x86 and arm64 runners (see
  the comment on `ts-screenshots` in `.github/workflows/ci.yml`).
- **A Stop hook running the full suite**, blocking the turn from ending on failure. Takes
  verification off the per-edit critical path entirely and makes it unskippable — strictly
  stronger than the prose in PR 5. Downside is that it fires on every turn end, including turns
  where the user only asked a question. Worth revisiting after PR 3 makes the suite cheap.
- **Turbo's local cache is unpruned** — 450MB across 10,365 entries in `.turbo/cache`. A disk
  question, not a speed one, but nothing currently trims it.
- **The `client` project's ~22s of Chromium and Vite startup** for 43 component tests. No fix
  that keeps the real-browser property the tier deliberately buys, so this is the floor unless
  the tier itself is revisited.

## Verification

The test stack must be running: `TEST_DB=1 scripts/supabase start`.

1. From the repo root: `pnpm lint && pnpm check && pnpm test`.
2. Re-time each stage and confirm the numbers moved as the PR claimed — the table in Context is
   the baseline to beat, on the same machine.
3. For PR 3 specifically, confirm both a hit and a miss: run `pnpm test` twice unchanged (second
   should be near-instant), then touch a file under `apps/web/src/` and confirm e2e and
   screenshots run again.
