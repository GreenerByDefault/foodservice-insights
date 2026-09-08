# Improve TypeScript test organization

## Context

The TS suite is 159 vitest files / ~1234 test declarations, and its weakest dimension is
grouping. Test *names* are already excellent and consistent — zero `should` titles, prose that
reads as behaviour — and the file layout is deliberate and documented ([`README.md`](README.md)
§ Testing tier table). What is missing is the second level of structure:

- **The maximum `describe` depth anywhere in the repo is 2**, and ~85% of files have
  `topLevelDescribes == totalDescribes` — no nesting at all.
- Ten `describe` blocks hold 10+ direct flat tests, the largest being
  `reapExpiredAttempts` (17) and `sendPendingNotifications` (15).
- The absence shows up as workarounds: helpers stranded at module scope because there is no
  block to hold them, group names typed by hand into every sibling test title, and preambles
  duplicated 11 times.
- **The convention is undocumented.** `.claude/rules/typescript.md` never mentions `describe`.
  Good and bad files sit side by side because there is no rule to point at, so the drift is
  structural rather than a series of individual lapses.

Good instances already exist to standardize on, so this is codifying a house style that is
already half-present, not inventing one.

Outcome: a second `describe` level where tests cluster, one shared DB assertion helper, and
one oversized file split. **No behaviour changes and no coverage changes** — the test count
must be identical before and after.

## The convention

`## Test organization` in [`.claude/rules/typescript.md`](.claude/rules/typescript.md) is
already documented (landed with the doc's own PR, alongside `packages/storage` and
`packages/core` as the first files nested under it). Four bullets, kept short per
[`writing-docs`](.claude/skills/writing-docs/SKILL.md): the top-level `describe` names the
subject (an exported symbol, a table, a component — one per subject), a nested `describe`
names the situation so the full path reads as a sentence, never spell the group into the test
title, and two levels is the working depth. Everything below applies that convention to the
remaining packages.

Not every flat file is wrong, and the rule says so implicitly by the "when tests share
a precondition" clause. [`apps/worker/src/worker.test.ts`](apps/worker/src/worker.test.ts) is
correctly flat: its seven top-level describes group by worker method, a genuinely
one-dimensional axis, and all setup is externalized to `testing/worker-harness.ts`.

## Reference files to imitate

- [`apps/worker/src/attempt/queue.test.ts`](apps/worker/src/attempt/queue.test.ts) — the
  primary template. Top-level describe per operation; nested describe per situation, each
  opening with the helper only that situation needs (`'under concurrency'` + `withPendingAttempts`,
  `'losing the race'` + `afterBeingReaped`).
- [`apps/worker/src/attempt/verdict.test.ts`](apps/worker/src/attempt/verdict.test.ts) —
  densest good nesting: one subject describe, eight situation describes, 25 tests in 283 lines.
- [`load-reports.test.ts`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/load-reports.test.ts)
  — the template for many small cases.

## PR stack

**This PR (the last one) lands directly on `improve-test-org`** (this branch) — it's small and
doesn't need review isolation. PRs 1-2 (`apps/worker`, `apps/web`) are big enough to want
independent review, so they go out as two separate branches/PRs off `main` — not a `gh-stack`
chain, just ordinary branches that start from `main` post-convention. Rebase each on `main`
before pushing: this is a pure-reorganization stack, so an upstream test added to a block being
restructured is a conflict every time — `packages/db`'s own PR already hit this once, from
`#291` landing on `organization.test.ts` mid-planning.

`packages/db` has landed. It added `expectConstraintViolation(work, constraint, code?)` in
[`packages/db/src/testing/constraints.ts`](packages/db/src/testing/constraints.ts), exported
from the [`testing/` barrel](packages/db/src/testing/index.ts), covering all 62 of that
package's constraint-violation assertions — the one instance of `toMatchObject`
[`AGENTS.md`](AGENTS.md) § Testing philosophy allows for now lives in one doc comment instead of
62 call sites. `apps/worker` and `apps/web` don't assert Postgres constraints directly, so
neither PR below needs it.

### PR 1 — `apps/worker`

- [`converge.test.ts`](apps/worker/src/sweeps/converge.test.ts) — the worst ratio in the repo
  (17 flat tests under `reapExpiredAttempts`). Split into which attempts it catches (L68-149),
  the shape of a sweep (L151-218), what the owning worker sees afterwards (L241-290), and
  under concurrency (L354-436). `raceReapAgainstCommittedWrite` (L598) and
  `raceReapAgainstCommittedRenewal` (L637) currently sit *after both describes* at the bottom
  of the file purely because no block exists to hold them; they move into the concurrency block.
- [`notifications.test.ts`](apps/worker/src/sweeps/notifications.test.ts) — 15 flat tests, and
  `const emailer = recordingEmailer();` appears 11 times. Split into which attempts it claims,
  backoff, a send that fails, and sweep caps and write guards; the repeated
  `aWorkerId()`/`recordingEmailer()` pair becomes per-block setup.
- [`directive.test.ts`](apps/worker/src/attempt/directive.test.ts) — the most mechanical
  conversion available. Two nested describes already use `'rule: description'` naming, and then
  11 sibling tests hand-type the same prefix (`'settling: …'`, `'contract-violation: …'`,
  `'progress-read-failed: …'` ×4, `'cancel-requested: …'`, `'hung: …'`, `'hard-timeout: …'`,
  `'lease-expired: …'`). Promote each prefix to a nested describe. Separately, split
  `'the state transition'` (L255, 9 flat) into `lastProgressAt` and `renewalIssuedAt`.
- [`lifecycle.test.ts`](apps/worker/src/attempt/lifecycle.test.ts) — `'failure rows'` (14 flat,
  L253-503) splits into the child's own failures (L269-355) and infrastructure failures
  (L370-486). `expectParkThenResume` is stranded at L114 *between* two describes and used by
  both; wrap them so it has a home. Convert the hand-rolled `for (const kill of KILLS)` at L525
  to `test.each`.
- [`config.test.ts`](apps/worker/src/config.test.ts) — five sibling `'the relations …'`
  describes are all validation of one function; nest them under `createWorkerConfig`.
- [`worker.test.ts`](apps/worker/src/worker.test.ts) — **stays flat**, deliberately. Only add
  `parked at upload` / `parked at record` under `'parked verdicts'` (L398-538), where five of
  six tests share an 8-line `withBreakable`/`withWorker`/`parkAtUpload` preamble and one uses
  a different store. Do **not** split this file; it is the reference for correct flatness.

### PR 2 — `apps/web`

- [`db.test.ts`](apps/web/src/lib/server/db.test.ts) — no `describe` at all, and 9 of 10 titles
  type the function name as a prefix (6 × `withDbErrorHandling`, 3 × `isUniqueViolation`). Add
  the two describes and strip the prefixes.
- [`upload-form.svelte.test.ts`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/new/upload-form.svelte.test.ts)
  — `UploadForm` (12 flat) splits into the server's response (L34-126), rejected before upload
  (L128-196), and props (L198-215). This is the archetype for every `*.svelte.test.ts`.
- [`fetch.test.ts`](apps/web/src/lib/api/fetch.test.ts) (12 flat),
  [`csv/read/layout.test.ts`](apps/web/src/lib/reports/csv/read/layout.test.ts) (12 flat),
  [`initials.test.ts`](apps/web/src/routes/(app)/shell/initials.test.ts) (14 tests, no describe
  — splits into normal names, astral/malformed Unicode, and invisible/control characters).
- [`load-reports.test.ts`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/load-reports.test.ts)
  — already the best-nested file; the one wart is `describe('_loadReports pagination')` being a
  *sibling* of `_loadReports`, so the identifier is repeated in the title instead of inherited.
  Make it a child.
- [`load-report.test.ts`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/load-report.test.ts)
  — `describe('report.siteName')` wraps a single test next to a describe of seven; fold it in.

## Explicitly not doing

- **No file splits beyond `result_file`.** The layout is already deliberate — co-located unit
  tests, `packages/db/tests/` for database invariants, `apps/web/e2e/` for Playwright — and it
  is documented in [`README.md`](README.md) § Testing. Test-to-source line ratios are healthy
  (`worker.test.ts` 775 : `worker.ts` 488).
- **No e2e changes.** All 24 Playwright files are small and single-purpose; the file path is
  the grouping, and Playwright reports by path. Adding `test.describe` there would be noise.
- **No `test.each` collapsing** of the DB invariant tests, per the answered question.
- **No title rewrites** beyond stripping prefixes that a `describe` now supplies. The naming
  is already the strongest thing about this suite.
- **No parametrization cleanup.** Worth knowing but out of scope: `apps/web` uses `test.for`
  (~30 files), `apps/worker` and `packages/db` use `test.each` (~22 sites), and two files use
  `it.each` ([`failures.test.ts`](apps/worker/src/failures.test.ts),
  [`retry.test.ts`](apps/worker/src/retry.test.ts)) — the only `it` in a repo that otherwise
  uses `test`. The two `for`-loop-to-`test.each` conversions in PR 1 are included only because
  they sit inside blocks being restructured anyway.

## Verification

The safety property for a pure reorganization is that the same tests still run and still pass.

1. Per package while iterating: `pnpm --filter @gbd/<pkg> test:unit -- path/to/thing.test.ts`.
2. Per PR, capture the test count on the branch point *before* touching anything, then compare
   after — it must be identical. Test *names* change as describe paths change, so compare counts
   and pass/fail, not name lists:
   `pnpm --filter @gbd/<pkg> test:unit -- --reporter=json`
   Take the baseline per PR rather than hardcoding a number — `main` has already moved once
   during planning, and each PR in the stack rebases onto whatever `main` is current when it's
   built.
3. The gate, run in the background per
   [`.claude/rules/typescript.md`](.claude/rules/typescript.md):
   `pnpm lint && pnpm check && pnpm test`
4. `pnpm test:system` is **not** in the gate and is not needed here — no Dockerfile, service
   startup, or cross-stack seam is touched.

**Open:** whether `packages/db/src/testing/constraints.ts` should also replace the handful of
`resolves.toBeUndefined()` "accepts" cases with a matching `expectAccepted` helper. Left out
for now — one helper is simpler, and the accept cases are already one line.
