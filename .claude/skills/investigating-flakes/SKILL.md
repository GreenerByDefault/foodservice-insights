---
name: investigating-flakes
description: How to get real evidence for a flaky or failing test, locally or in CI — where the evidence lives, how to reproduce, and which convincing theories have turned out wrong. Load when asked to investigate a flake, a CI failure, a screenshot pixel diff, or a slow test. Not for a flake you merely hit; AGENTS.md says to report those and move on.
---

# Investigating flakes

Every theory here has looked causal and been wrong at least once: transitions, viewport nudges,
a Chromium bug. Get evidence before you fix anything.

## In CI, start from the trace, not the log

- **The job log is useless for timing.** Turbo buffers a task's output and flushes it at the
  end, so every line carries the same timestamp.
- **The evidence is in the job's artifact** ([`ci.yml`](../../../.github/workflows/ci.yml)
  names them). `error-context.md` holds the aria snapshot at failure. `trace.zip` unpacks to
  `0-trace.network`, with each request's status and `_failureText`, and `0-trace.trace`, with
  console messages and `pageError` events. A screenshot failure's `screenshot-diffs` artifact also
  has `*-expected.png`, `*-actual.png` and `*-diff.png`. Its `screenshots` artifact is only the
  regenerated set.
- **A re-run uploads an artifact with the same name**, so `gh run download -n` fetches the
  retry's. List them with `gh api repos/{owner}/{repo}/actions/runs/<id>/artifacts` and fetch the
  failed attempt's by id (`.../artifacts/<id>/zip`). `.../runs/<id>/attempts/1/jobs` gives that
  attempt's job ids, and `.../jobs/<job id>/logs` its log.
- **Before blaming a PR, compare the "Runner Image" group** in each job log for a passing and a
  failing run.
- **A job that runs past its `timeout-minutes` and ignores a cancel is a lost runner, not a hung
  test**: the runner agent enforces both. `POST .../actions/runs/<id>/force-cancel` ends it, and
  since that attempt's log is never uploaded, there is nothing to investigate — re-run instead.

## Locally, reproduce before theorizing

- **Repeat one spec in isolation**: `--repeat-each 40 --workers=1`, run through Turbo
  ([`typescript.md`](../../rules/typescript.md) § Verifying a change says why).
- **For a pixel flake, hash the actual images across runs.** Identical hashes that all differ
  from the baseline mean you should re-baseline: it isn't a flake. Otherwise, diff expected and
  actual pixel by pixel with Pillow (installed), and tabulate one tell-tale pixel across variants
  of the fix. Playwright's diff image alone doesn't say which shade changed.
- **Fix the test, not the product.** A product change made only to steady a test is rejected.

## Rule out the machine

The dev machine is often saturated by other checkouts' sessions and their Supabase stacks.

- **Run `uptime` and `pgrep -x yes` before and after any timing**, and kill background load you
  spawned in the same command that spawned it.
- **Under CPU saturation, Chromium's launch and close go from milliseconds to tens of seconds**,
  with the process runnable, no user CPU accrued, and `sample` returning an empty call graph.
  That reads convincingly as a Chromium bug. It isn't one.
- **"Target page, context or browser has been closed"** in a screenshot run can be another
  session stopping the shared browser container.
