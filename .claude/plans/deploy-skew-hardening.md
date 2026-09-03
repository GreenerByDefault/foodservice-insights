# Hardening for out-of-step deploys

## Context

Two services deploy on separate schedules against one shared Postgres, and there is no way to make
them land together — so the web ↔ worker and app ↔ schema contracts must stay backwards compatible
until every old instance is gone. Web deploys, migrations included, on every push to `main`
([`workflows/deploy.yml`](../../.github/workflows/deploy.yml)); the worker deploys only when
dispatched for a specific commit. So the skew always points one way: **the deployed worker is the
one running behind** — the invariant `ARCHITECTURE.md` § Deployments records.

Two items remain. The first closes a gap [`config.ts`](../../apps/worker/src/config.ts) explicitly
documents as uncheckable; the second only works if it ships before the change it guards.

*Already landed:* the failure-reason lookup in
[`failure-copy.ts`](<../../apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/failure/failure-copy.ts>)
now falls back to the `unknown` copy instead of reading `.whatHappened` off `undefined` — the case
was a migration adding a `failure_reason` value a newer worker writes while an old web app, compiled
against the prior enum, is still serving. Logging the build at boot is deferred to
[`hosting-provider-notes.md`](hosting-provider-notes.md) § Once a provider is chosen, since
normalizing "whichever env var the provider injects" needs the provider decided first.

## a. Close the drain-grace gap

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

## b. Add the claim-time capability guard, while it is still a no-op

Add `required_contract_version smallint not null default 1` to `analysis_attempt`, and a
`where required_contract_version <= $ours` predicate to `nextPendingAttempt` in
[`queue.ts`](../../apps/worker/src/attempt/queue.ts), beside the existing cancel-request filter. An
old worker then *leaves* work it cannot handle in the queue instead of claiming and failing it — the
attempt waits for the worker deploy rather than burning one of the user's retries, and the
already-planned "attempts waiting too long to be claimed" alert is what notices. The deploy
workflow deliberately has no "worker needs deploying" check of its own — this guard plus that
alert are the only signal a stale worker needs.

**The reason to do it now, when it guards nothing: the guard only works if it shipped before the
change it guards.** On the first genuinely incompatible change, the worker that must hold back is the
*old* one — the one already deployed. Adding the predicate at that point is too late by exactly one
deploy.

Follows [`packages/db/README.md`](../../packages/db/README.md) § Conventions: named constraint, plus a
test in `packages/db/tests/` asserting the database rejects a violation.

*Rejected: a lint blocking destructive migration DDL.* The expand/contract discipline is already in
[`README.md`](../../README.md#add-a-database-migration); a pattern-matcher over migration text would
fire on the safe cases and miss the unsafe ones.

## Verification

`pnpm lint && pnpm check && pnpm test` from the repo root. Per item:

- Drain-grace relation: a `config.test.ts` case per direction, in the existing table-driven
  `workerConfigViolations` style.
- Claim guard: a `queue.test.ts` case proving an attempt above the worker's version stays `pending`
  while a worker at the higher version claims it — via `packages/db/src/testing/concurrency.ts`, not
  `withRollback`, since two claimants is the point.
