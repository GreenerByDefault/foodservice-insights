# Hardening for out-of-step deploys

## Context

Two services deploy on separate schedules against one shared Postgres, and there is no way to make
them land together — so the web ↔ worker and app ↔ schema contracts must stay backwards compatible
until every old instance is gone. Web deploys, migrations included, on every push to `main`
([`workflows/deploy.yml`](../../.github/workflows/deploy.yml)); the worker deploys only when
dispatched for a specific commit. So the skew always points one way: **the deployed worker is the
one running behind** — the invariant `ARCHITECTURE.md` § Deployments records.

One item remains: closing the gap [`config.ts:48-55`](../../apps/worker/src/config.ts) explicitly
documents as uncheckable — the platform's shutdown grace against `drainGraceMs + killGraceMs` plus
one terminal write.

*Already landed:* the failure-reason lookup in
[`failure-copy.ts`](<../../apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/failure/failure-copy.ts>)
now falls back to the `unknown` copy instead of reading `.whatHappened` off `undefined` — the case
was a migration adding a `failure_reason` value a newer worker writes while an old web app, compiled
against the prior enum, is still serving. Logging the build at boot is deferred to
[`hosting-provider.md`](hosting-provider.md) § After the decision, since
normalizing "whichever env var the provider injects" needs the provider decided first.

Also landed: `analysis_attempt.required_contract_version` (`smallint not null default 1`) and the
`where required_contract_version <= $ours` predicate `nextPendingAttempt`
([`queue.ts`](../../apps/worker/src/attempt/queue.ts)) applies beside the existing cancel-request
filter, comparing against `WORKER_CONTRACT_VERSION` (currently `1`, so the comparison is a no-op
today). An old worker now leaves an attempt it cannot handle in the queue instead of claiming and
failing it, for whenever a future change first needs the guard — that guard had to ship before the
change it guards, since on the first genuinely incompatible change the worker that must hold back is
whichever one is already deployed.

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

Sizing is a provider question — see [`hosting-provider.md`](hosting-provider.md) § Draining the
worker. A drain worth having is minutes, not seconds, since an attempt averages ~5 minutes.

## Verification

`pnpm lint && pnpm check && pnpm test` from the repo root, plus a `config.test.ts` case per
direction for the drain-grace relation, in the existing table-driven `workerConfigViolations` style.
