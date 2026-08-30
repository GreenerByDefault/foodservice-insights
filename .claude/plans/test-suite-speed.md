# Test suite speed

## Context

`pnpm test` takes ~97s locally after a typical change, and AGENTS.md § Verifying a change makes
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
| `pnpm test:screenshots` | **~25s — always** | ~25s |
| **`pnpm test`** | **~68s floor** | **~97s** |

Turbo is doing its job: `check` and `test:unit` collapse to ~2.6s combined when untouched. The
finding is that `turbo.json` marks `test:e2e` and `test:screenshots` `cache: false`, so **67 of
the ~97 seconds go to two tasks Turbo is structurally forbidden from skipping** — including on a
Markdown-only edit. This is not a missing build system; it is two opted-out tasks.

The screenshot row already reflects a landed fix: `optimize-screenshots.teardown.ts` used to
re-run oxipng on every local `test:screenshots`, re-optimizing already-optimized PNGs the run
never wrote, costing 10s. It now skips via `wroteScreenshots()`
(`apps/web/scripts/optimize-screenshots.ts`), which checks `git status --porcelain` on the
screenshots directory instead of `updateSnapshots === 'none'` — so it also catches a plain local
run against committed images, not just CI.

Where the remaining time goes, all measured rather than inferred:

- **e2e and screenshots each boot the app separately** — truncate + migrate + seed +
  adapter-node, twice per `pnpm test`.
- The `client` project is ~34s wall standalone against 12.4s of reported test duration; the gap
  is Chromium + Vite startup for 43 component tests. No cheap fix that keeps the real browser.
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
the gate in the background. See PR 2.

Test *flakes* were PR 5 of this plan and now live in
[`test-suite-flakes.md`](test-suite-flakes.md). They are the larger agent-wall-clock cost — with
`retries: 0`, one flake costs a full re-run, more than every caching win here combined — but they
are a correctness problem, not a speed one, and nothing in this plan depends on them.

## PR 1 — Make `test:e2e` and `test:screenshots` cacheable

The one that matters: −67s whenever a change provably cannot reach them.

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
- **Locally, `updateSnapshots: 'missing'` writes into the source tree**, mutating an input. Since
  `wroteScreenshots()` landed, that only happens when a snapshot is genuinely new, which is a real
  change and *should* miss the cache next run. Confirm that is what happens.

If full caching turns out to be too loose, the fallback is running `--affected` locally, exactly
as CI already does via `TURBO_SCOPE`. That is strictly weaker — it depends on git state — so
prefer caching and keep this in reserve.

## PR 2 — AGENTS.md: separate the iteration loop from the gate

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

## Follow-ups this work identifies but does not do

- **One Playwright invocation for both projects.** `test:e2e` and `test:screenshots` boot the app
  separately; they are already two projects in one config, so `playwright test --project=e2e
  --project=screenshots` would boot once. This must stay a local convenience script and not
  replace the two tasks, because CI deliberately splits them across x86 and arm64 runners (see
  the comment on `ts-screenshots` in `.github/workflows/ci.yml`).
- **A Stop hook running the full suite**, blocking the turn from ending on failure. Takes
  verification off the per-edit critical path entirely and makes it unskippable — strictly
  stronger than the prose in PR 2. Downside is that it fires on every turn end, including turns
  where the user only asked a question. Worth revisiting after PR 1 makes the suite cheap.
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
3. For PR 1 specifically, confirm both a hit and a miss: run `pnpm test` twice unchanged (second
   should be near-instant), then touch a file under `apps/web/src/` and confirm e2e and
   screenshots run again.
