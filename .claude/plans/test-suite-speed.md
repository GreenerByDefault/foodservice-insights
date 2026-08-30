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

Turbo is doing its job: `check` and `test:unit` collapse to ~2.6s combined when untouched. Until
this plan, `turbo.json` marked `test:e2e` and `test:screenshots` `cache: false`, so **67 of the
~97 seconds went to two tasks Turbo was structurally forbidden from skipping** — including on a
Markdown-only edit. That was not a missing build system; it was two opted-out tasks, and it is
now fixed: both tasks' real inputs were already in the graph (`test:e2e` depends on `build`,
which depends on `^build`, so `packages/db` migrations and every other package's source are
transitively hashed), so turning caching back on was enough — a run that provably cannot reach
either task now skips it entirely.

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

What replaces that is a loop-versus-gate distinction, which needs no judgement call, plus
running the gate in the background — both landed in
[`.claude/rules/typescript.md`](../rules/typescript.md) rather than AGENTS.md, since the
loop-vs-gate rule is specific to the TypeScript stack's tooling (`pnpm`, vitest, Playwright) and
AGENTS.md's § Verifying a change is shared with Python, which has no equivalent scoped-file
invocation. `pnpm lint && pnpm check && pnpm test` stays the gate before claiming a change works,
verbatim, unchanged by any of this.

Test *flakes* were PR 5 of this plan and now live in
[`test-suite-flakes.md`](test-suite-flakes.md). They are the larger agent-wall-clock cost — with
`retries: 0`, one flake costs a full re-run, more than every caching win here combined — but they
are a correctness problem, not a speed one, and nothing in this plan depends on them.

Two follow-ups from the original caching work are worth doing and are scoped below as PR 1 and
PR 2. The others considered — a Stop hook running the full suite, and pruning Turbo's local
cache — were dropped: the Stop hook is a real option but a bigger behavioral change than this
plan's scope, and the cache is a disk question, not a speed one.

## PR 1 — one Playwright invocation for local runs

`test:e2e` and `test:screenshots` each boot the app separately — truncate + migrate + seed +
adapter-node, twice per `pnpm test`. They're already two projects (`e2e`, `screenshots`) in one
`apps/web/playwright.config.ts`, so `playwright test --project=e2e --project=screenshots` boots
the app once and runs both.

This must stay a local convenience script, not replace the two `turbo.json` tasks: CI
deliberately splits them across runners — `ts-e2e` on `ubuntu-latest` (x86, matching
production), `ts-screenshots` on `ubuntu-24.04-arm` (arm64, so the pinned screenshot browser
container runs native rather than emulated; see the comment above `ts-screenshots` in
`.github/workflows/ci.yml`). Collapsing them there would put screenshots back under emulation or
e2e on the wrong architecture.

- Add a script (e.g. `apps/web/package.json`'s `test:local` or similar — name TBD at
  implementation) that runs `playwright test --project=e2e --project=screenshots` directly,
  bypassing Turbo's two-task split.
- It needs both tasks' env: `TEST_DB=1`, and the `browser-container` project's setup that
  `screenshots` depends on.
- Leave `turbo.json`'s `test:e2e` and `test:screenshots` and the root `test` script untouched —
  this is an addition, not a replacement, since CI and `pnpm test` still need the two-task split.

## PR 2 — investigate the `client` vitest project's startup cost

The `client` project (`apps/web/vite.config.ts`, `test.projects[].test.name === 'client'`) is
~34s wall standalone against 12.4s of reported test duration for 43 component tests; the gap is
Chromium + Vite startup via `@vitest/browser-playwright`. Filed as an open question rather than a
committed change, because the fix (if any) isn't yet known — this PR is to spend time finding
out, not to implement a specific idea:

- Confirm where the ~22s actually goes — Chromium launch, Vite dev-server cold start, or
  per-file overhead multiplied by however vitest shards `client` — before assuming which one to
  attack.
- A fix must keep the real-browser property the tier deliberately buys (that's why `client`
  exists instead of jsdom); anything that swaps in a fake DOM to save time is out of scope and
  was already rejected implicitly by this tier's existence.
- If nothing pans out, close this out as "the floor for this tier" rather than leaving it open
  indefinitely.

## Verification

The test stack must be running: `TEST_DB=1 scripts/supabase start`.

1. From the repo root: `pnpm lint && pnpm check && pnpm test`.
2. Re-time each stage and confirm the numbers moved as the PR claimed — the table in Context is
   the baseline to beat, on the same machine.
3. For PR 1: time the new local script against the current `pnpm test:e2e && pnpm test:screenshots`
   and confirm one app boot instead of two; run `ts-e2e` and `ts-screenshots` in CI unchanged and
   confirm both still pass on their respective runners.
