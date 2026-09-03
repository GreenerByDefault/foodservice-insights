# Hardening for out-of-step deploys

## Context

Two services deploy on separate schedules against one shared Postgres, and there is no way to make
them land together — so the web ↔ worker and app ↔ schema contracts must stay backwards compatible
until every old instance is gone. Given the model in [`deploy-pipeline.md`](deploy-pipeline.md) the
skew always points one way: **the deployed worker is the one running behind.**

Four items. The first is a bug that exists today; the second closes a gap
[`config.ts`](../../apps/worker/src/config.ts) explicitly documents as uncheckable; the third only
works if it ships before the change it guards.

## a. Make the failure-reason lookup total

[`failure-copy.ts`](<../../apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/failure/failure-copy.ts>)
does `ANALYSIS_FAILURE_EXPLANATIONS[reason]` and immediately reads `.whatHappened`. A migration adds
an enum value, a new worker writes it, an old web app is still up — `undefined.whatHappened`, 500 on
the report page. `failure_reason` is the volatile vocabulary here; it grows as the analysis library
lands. Fall back to the `unknown` copy.

`status` is a fixed five-value state machine and needs no equivalent.

## b. Close the drain-grace gap

[`config.ts:48-55`](../../apps/worker/src/config.ts) names the one relation `createWorkerConfig`
cannot check: the platform's shutdown grace against `drainGraceMs + killGraceMs` plus one terminal
write. Make it checkable.

- `WORKER_DRAIN_GRACE_MS`, read in [`main.ts`](../../apps/worker/src/main.ts) beside
  `WORKER_MAX_CONCURRENT_ATTEMPTS` via the existing `optionalIntEnv`. Defaults unchanged (30s + 10s).
- Optional `PLATFORM_SHUTDOWN_GRACE_MS`, plus a `workerConfigViolations` check that the sum fits
  inside it when set. The provider config sets it on the same service block that sets the platform's
  own grace, so the two cannot drift — that is what turns an unverifiable relation into a verifiable
  one.
- Update the `drainGraceMs` doc comment: the relation is now checked, and where.

Sizing is a provider question — see [`hosting-provider-notes.md`](hosting-provider-notes.md). A drain
worth having is minutes, not seconds, since an attempt averages ~5 minutes.

## c. Add the claim-time capability guard, while it is still a no-op

Add `required_contract_version smallint not null default 1` to `analysis_attempt`, and a
`where required_contract_version <= $ours` predicate to `nextPendingAttempt` in
[`queue.ts`](../../apps/worker/src/attempt/queue.ts), beside the existing cancel-request filter. An
old worker then *leaves* work it cannot handle in the queue instead of claiming and failing it — the
attempt waits for the worker deploy rather than burning one of the user's retries, and the
already-planned "attempts waiting too long to be claimed" alert is what notices.
[`deploy-pipeline.md`](deploy-pipeline.md) leans on this as the only signal a stale worker needs.

**The reason to do it now, when it guards nothing: the guard only works if it shipped before the
change it guards.** On the first genuinely incompatible change, the worker that must hold back is the
*old* one — the one already deployed. Adding the predicate at that point is too late by exactly one
deploy.

Follows [`packages/db/README.md`](../../packages/db/README.md) § Conventions: named constraint, plus a
test in `packages/db/tests/` asserting the database rejects a violation.

*Rejected: a lint blocking destructive migration DDL.* The expand/contract discipline is already in
[`README.md`](../../README.md#add-a-database-migration); a pattern-matcher over migration text would
fire on the safe cases and miss the unsafe ones.

## d. Log the build at boot

Both services log their commit at startup, from whichever env var the provider injects, normalized to
one `GIT_SHA`. This is what answers "which of these two is behind?" when a deploy half-fails, or when
one of two worker replicas did not restart — neither of which the `deploy/worker` tag can see, since
it records what we asked for rather than what is running.

*Not on `/health`.* That route is unauthenticated and deliberately reports only `ok`/`degraded` —
"which check failed stays in the log"
([`+server.ts`](../../apps/web/src/routes/health/+server.ts)). Publishing a private repo's deployed
commit there breaks the same reasoning that keeps the failure detail out.

*Rejected: a `worker_instance` fleet table.* For a two-worker fleet the provider dashboard already
shows the deployed commit per service, and a boot log line covers the rest. Revisit if the fleet grows,
or if a deploy ever silently half-lands.

## Verification

`pnpm lint && pnpm check && pnpm test` from the repo root. Per item:

- Failure-reason fallback: a unit test passing a reason absent from `ANALYSIS_FAILURE_EXPLANATIONS`,
  asserting copy rather than a throw.
- Drain-grace relation: a `config.test.ts` case per direction, in the existing table-driven
  `workerConfigViolations` style.
- Claim guard: a `queue.test.ts` case proving an attempt above the worker's version stays `pending`
  while a worker at the higher version claims it — via `packages/db/src/testing/concurrency.ts`, not
  `withRollback`, since two claimants is the point.
