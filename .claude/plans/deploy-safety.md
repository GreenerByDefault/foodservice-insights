# Deploy safety

## Context

A review on 2026-10-08 of what can break when deploying web and worker, on top of the mitigations
already in place: image-per-commit promotion, `deploy-web`'s supersession guard, the
worker-runs-behind invariant, the drain with its `config.ts` relations, migrations from the
workspace rather than the image, deploys that only ever fix forward, report pages that reload once
their poll is answered by another deploy, a web server that refuses to start without its config
(`assertConfigured`, from `init` in [`hooks.server.ts`](../../apps/web/src/hooks.server.ts)),
`ts-db-types` migrating the base branch first so that Kysely refuses a migration out of order or
missing, as the hosted database would, and the gate in
[`deploy-target`](../../.github/actions/deploy-target/action.yml) that both deploy jobs pass
first. That gate deploys only a commit on main. `deploy-web` moves a `deploy/web` tag on success,
and `deploy-worker` refuses a commit that is not behind it. Nothing deploys for real yet —
[`deploy-service`](../../.github/actions/deploy-service/action.yml) is a stub and
[`deploy-migrations.md`](deploy-migrations.md) has not landed — so each fix here is cheapest now.

Facts marked **verified** were checked on 2026-10-08.

Findings that went elsewhere rather than into a PR here:

- **One DigitalOcean app would redeploy the worker on every web push** — a note in
  [`hosting-provider.md`](hosting-provider.md) § After the decision.
- **Migration lock contention** — a problem statement in [`deploy-migrations.md`](deploy-migrations.md),
  whose PR owns the migration session's settings.
- **Health check as readiness, not liveness** — also in `hosting-provider.md`, since it is
  provider config.

## Decisions

- *Rejected: rollbacks in `deploy.yml`.* Most of what this review found in them — a re-run
  dispatch rolling prod back, a queued rollback cancelled by the next push, a migrate step that
  must know when to skip — came from deploying an arbitrary older commit. A bad deploy is reverted
  instead, and the host's dashboard rollback covers an outage that can't wait
  (`ARCHITECTURE.md` § Bad deploys are fixed forward).
- *Rejected: checking in-flight attempts before a worker deploy.* "Dispatch it at a quiet hour"
  stays a human judgement.
- *Rejected: pinning the UBI base images by digest.* The image CI tests (`tests/e2e` builds its
  own) and the image `deploy.yml` pushes can sit on different `:latest` bases, but UBI minimal is
  conservative within a major, and a digest pin plus Dependabot's `docker` ecosystem is a PR per
  base bump for little caught. Revisit if a base update ever breaks a deploy.
- *Considered: a merge queue instead of deploys following main's CI.* Available to a public org
  repo (`ci.yml` would need `merge_group`), and it keeps main green rather than only gating
  deploys, but costs latency on every merge. Deploys follow main's CI instead (PR 2).
- *Rejected: checking config in `/health`.* The web app validates config at startup instead —
  `assertConfigured` builds every lazy handle (database, blob store, emailer, logger, and the
  Supabase project in `supabase` mode), so a missing variable crashes the server, as the worker's
  config does, and the deploy's health check never passes. It checks handles rather than a list
  of variable names, so a variable added to an existing handle needs no change there; a new
  handle needs one line. And it leaves `/health` free for `observability-vendors.md`'s split into
  liveness and a dependency check.
- **Open:** whether a rollback should reuse the digest it shipped before. `deploy-service`
  resolves `:<sha>` again, and tags are mutable — `force_rebuild`, or any same-repo branch's
  workflow with `packages: write`, can repoint one. Each `deploy/*` tag records the digest it
  shipped, but nothing reads it back.

## PR 1 — Production secrets live in a `production` Environment

Coupled to repo settings, so it lands with them. A human has created the `production` Environment
but not yet configured it.

`deploy-migrations.md` adds six production secrets; as repo secrets they reach any `pull_request`
run from a same-repo branch, so any PR — agent-authored included — can edit `ci.yml` and print
them. Both deploy jobs declare `environment: production`; the Environment limits deployment
branches to `main` and holds the secrets. The secrets living only there is the boundary: a
dispatch runs the chosen branch's own `deploy.yml`, which can drop the declaration and
`deploy-target`'s branch check alike, but then has no credentials. The branch rule and that check
stop honest mistakes; keep both.

While these jobs gain prod credentials (on top of `packages: write` and `contents: write`), pin
their third-party actions by SHA — including those inside the composite actions they call
(`deploy-service`'s `docker/setup-buildx-action`). Dependabot's `github-actions` ecosystem already
keeps such pins current.

## PR 2 — Web deploys once main's CI passes

The `main branch` ruleset requires `CI` but not an up-to-date branch, auto-merge is on, and PR CI
runs `--affected` (**verified**). Two PRs green apart can be red together, and `deploy-web` ships
them — and once `deploy-migrations.md` lands, migrates them — before main's own CI has tested the
merged commit.

**`deploy-web` runs when CI completes, rather than on push.** `deploy.yml` keeps `push` for the
builds and adds `workflow_run` on `CI` `completed`; `deploy-web` ships
`github.event.workflow_run.head_sha` when that run's conclusion is `success` and its event is
`push`. The event check is the boundary, not `branches: [main]`, which also matches a fork's PR
from a branch named `main` — and this job will hold prod credentials. Builds finish well inside
main's CI (**verified** 2026-10-11: under two minutes against four to eight), and `deploy-service`
already fails clearly on a missing image.

A trigger instead of a wait means a failed or cancelled CI never starts a deploy, re-running a
flaked CI fires `workflow_run` again so the deploy follows, `deploy-web` holds its concurrency
slot only while deploying, and tooling from main's tip still holds, since `workflow_run` runs the
default branch's workflow. *Rejected: polling for CI inside `deploy-web`* (#489's first draft) —
the job held the `deploy-web` slot for the whole CI run, and a rollback dispatched meanwhile sat
pending, where the next push cancels it.

**A dispatch checks CI once, without waiting**, in `deploy-target`: refuse unless main's CI on the
target concluded `success`. A rollback targets a commit whose CI finished long ago; a blank `sha`
whose CI is still running is refused, since its `workflow_run` deploy will ship it. When the
target's CI failed or was cancelled, the message leads with picking an older commit whose CI
passed — re-running an older commit's CI joins `ci.yml`'s concurrency group on main, where it can
replace a newer commit's pending run.

**A blank-`sha` dispatch gets the supersession check too.** A re-run keeps its first attempt's
`github.sha`, so re-running a failed blank-`sha` dispatch after a newer push deployed would roll
prod back. With the check, every re-run is safe, and a message can just say "re-run this job".

**`queue: max` on both deploy jobs' `concurrency`.** By default a newly queued job cancels the one
already pending, so a rollback waiting behind a push deploy is dropped by the next push.

**Open:** `queue: max` on `ci.yml`'s push concurrency as well, so no run on main is cancelled and
every commit is a rollback target, at the cost of a serial queue on a busy day. Two of 40 runs on
main were cancelled as of 2026-10-11.

## PR 3 — The fleet's connections fit the session pooler

A dedicated PR. No pool has been tuned yet; `WORKER_DB_LIMITS` is `DEFAULT_LIMITS` with a TODO.

The problem, in two halves:

1. **Budget.** Supavisor's session mode caps clients at the project's *Pool Size* per
   role + database — around 15 on the small compute tiers; check Database Settings. Web and worker
   both use `maxConnections: 10` ([`client.ts`](../../packages/db/src/client.ts)). One web and the
   planned two workers can ask for 30, a deploy's old/new overlap adds a service's worth more, and
   the migration step and anyone in Studio share the same cap.
2. **Classification.** Supavisor rejects a connection over the cap with
   `FATAL XX000 (EMAXCONNSESSION) max clients reached in session mode…` (**verified** in
   `supabase/supavisor`'s `max_connections_error.ex` and `proxy_test.exs`). `XX000` is not in
   `TRANSIENT_SQL_STATES` ([`errors.ts`](../../packages/db/src/errors.ts)), so it counts as a
   statement Postgres refused. The worker's claim poll treats that as "drain and exit nonzero"
   ([`worker.ts`](../../apps/worker/src/worker.ts) `pollQueue`) — killing its in-flight attempts
   as `shut_down` at exactly the busy moment that exhausted the pool. The web answers 500 instead
   of 503.

Likely shape: treat `EMAXCONN*` as transient (a message match, the way
`TRANSIENT_DRIVER_MESSAGES` already works, with a test pinning the string), and write the budget
down — Σ `maxConnections` across every process alive during a deploy overlap, plus migrations,
within Pool Size — then set Pool Size or the per-service maxima to fit. Separate roles per
service would each get their own cap; weigh that against one more credential to manage.

## PR 4 — The worker refuses a production config that would fail silently

- **Drain grace.** `drainGraceMs` defaults to 30s and `PLATFORM_SHUTDOWN_GRACE_MS` is optional
  ([`config.ts`](../../apps/worker/src/config.ts)). Forget `WORKER_DRAIN_GRACE_MS` and every
  worker deploy kills in-flight attempts at 30s, recorded as an ordinary `shut_down`. In `live`
  mode, require `PLATFORM_SHUTDOWN_GRACE_MS` and derive `drainGraceMs` from it — platform grace
  minus `killGraceMs` minus `MAX_RENEWAL_ROUND_TRIP_MS` — so there is one number to set, beside the
  platform's own. An explicit `WORKER_DRAIN_GRACE_MS` still overrides, and the existing relation
  still checks it.
- **API key.** In `live` mode a missing `OPENAI_API_KEY` fails every attempt and emails every
  requester. `resolveWorkerMode` ([`modes.ts`](../../apps/worker/src/modes.ts)) already requires
  `PYTHON_BIN` per mode; require the key the same way, so it is a crash on boot instead.

Update `hosting-provider.md` § After the decision item 2, which currently says to set
`drainGraceMs` by hand.

## PR 5 — Smoke-test every deploy

Blocked on the hosting decision: it needs the public URL. The first step toward synthetics.

After `deploy-service` in both jobs' web path: request `/health` through Cloudflare, and make one
mutating request. `HOST_HEADER` misconfiguration fails SvelteKit's CSRF check only on non-GET
requests (`hosting-provider.md` § After the decision, item 3), so a GET-only smoke passes a deploy
where every form is broken. Fail the job on either.

## Before launch

Not PRs here; sequencing checks for whoever flips production on.

- **The site password is not implemented anywhere.** `auth.md` scopes it out, yet placeholder mode
  in production depends on it: without it, the internet is the placeholder admin, spending AI
  budget. Cloudflare Access in front needs no code.
- **CI-built worker images have no categorization cache.** The CSV is gitignored, so the CI
  checkout lacks it; `live` mode logs one warning and sends every product to the LLM — cost,
  runtime, and consistency. A locally built image *does* include it, so local system e2e hides
  this. Land `categorization-cache.md` first, or make `live` fail loudly without a cache.
- **`live` never runs in an image before production.** System e2e uses `mock-llm`.
- **The alerts `observability-vendors.md` promises** — stuck, failing, unclaimed attempts — are
  what catch a bad worker deploy. Land those before the first worker deploy with real users.

## Verification

Per PR, from the repo root: `pnpm lint && pnpm check && pnpm test`.
PR 1 by dispatching from a branch whose workflow declares the Environment and confirming it is
refused before any step runs. PR 2 after it merges: the push run only builds, the `workflow_run`
run deploys once CI passes, and a dispatch naming a commit whose CI failed is refused. PR 3 by
holding more session-mode connections than Pool Size against the dev stack's pooler and
confirming the worker keeps ticking.
