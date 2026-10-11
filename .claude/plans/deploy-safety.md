# Deploy safety

## Context

A review on 2026-10-08 of what can break when deploying web and worker, on top of the mitigations
already in place: image-per-commit promotion, `deploy-web`'s supersession guard, the
worker-runs-behind invariant, the drain with its `config.ts` relations, migrations from the
workspace rather than the image, rollbacks skipping migrations, report pages that reload once
their poll is answered by another deploy, a web server that refuses to start without its config
(`assertConfigured`, from `init` in [`hooks.server.ts`](../../apps/web/src/hooks.server.ts)), and
`ts-db-types` migrating the base branch first so that Kysely refuses a migration out of order or
missing, as the hosted database would. Nothing deploys for real yet —
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

- *Rejected: a switch to pause web auto-deploy after a rollback.* A rollback lasts only until the
  next merge, but merges are infrequent enough that this is overkill.
- *Rejected: checking in-flight attempts before a worker deploy.* "Dispatch it at a quiet hour"
  stays a human judgement.
- *Rejected: pinning the UBI base images by digest.* The image CI tests (`tests/e2e` builds its
  own) and the image `deploy.yml` pushes can sit on different `:latest` bases, but UBI minimal is
  conservative within a major, and a digest pin plus Dependabot's `docker` ecosystem is a PR per
  base bump for little caught. Revisit if a base update ever breaks a deploy.
- *Rejected: checking config in `/health`.* The web app validates config at startup instead —
  `assertConfigured` builds every lazy handle (database, blob store, emailer, logger, and the
  Supabase project in `supabase` mode), so a missing variable crashes the server, as the worker's
  config does, and the deploy's health check never passes. It checks handles rather than a list
  of variable names, so a variable added to an existing handle needs no change there; a new
  handle needs one line. And it leaves `/health` free for `observability-vendors.md`'s split into
  liveness and a dependency check.

## PR 1 — `deploy.yml` deploys only merged, tested commits, with today's tooling

One file, one theme: what a deploy job is allowed to ship.

**Deploy tooling comes from main's tip, not the target SHA.** Both deploy jobs check out
`inputs.sha || github.sha` and then run `uses: ./.github/actions/deploy-service`, which is the
*target commit's* copy of the action (**verified**). Once the stub is replaced, a rollback to any
commit before that lands runs the stub: green, "Would deploy…", nothing deployed. Every later
rollback would also replay that commit's provider call and config-as-code. Check out `github.sha`
for tooling; pass `inputs.sha` only as the image to resolve (`git rev-parse` it to 40 characters
— `fetch-depth: 0` is already there). This loses nothing: a named-SHA dispatch skips migrations
(`deploy-migrations.md`), and a blank one targets the tip, where tooling and target are the same
tree. A rollback rolls back the image, not the deploy machinery — say so on the step.

**Only merged commits deploy.** `workflow_dispatch` runs from any branch, so a blank `sha` from a
feature branch deploys that branch, and once migrations are wired, migrates prod with unmerged
migrations. Both jobs require `git merge-base --is-ancestor "$sha" origin/main`.

**The worker never deploys ahead of the web.** A blank-`sha` worker dispatch takes main's tip even
while that push's `deploy-web` is still migrating, or after it failed. `deploy-web` moves a
`deploy/web` tag on success, mirroring `deploy/worker`; `deploy-worker` requires its SHA to be an
ancestor of `deploy/web`. `deploy-web` on a rollback also logs when the target is behind
`deploy/worker`, since the web ↔ worker contract then has to hold the other way round.

**Production secrets live in a `production` Environment.** The repo has no environments
(**verified**). `deploy-migrations.md` adds six production secrets; as repo secrets they reach any
`pull_request` run from a same-repo branch, so any PR — agent-authored included — can edit
`ci.yml` and print them. Both deploy jobs declare `environment: production`; a human creates it
with deployment branches limited to `main` and puts the secrets there. That also refuses a
dispatch from a branch before any step runs. While these jobs gain prod credentials (on top of
`packages: write` and `contents: write`), pin their third-party actions by SHA; Dependabot's
`github-actions` ecosystem already keeps such pins current.

**Deploys wait for main's CI.** The `main branch` ruleset requires `CI` but not an up-to-date
branch (`strict_required_status_checks_policy: false`), auto-merge is on, and PR CI runs
`--affected` (**verified**). Two PRs green apart can be red together, and today `deploy-web` ships
and — soon — migrates that before main's own CI finishes. Add a step to both deploy jobs, first,
that waits for the `CI` check run on the target SHA: success proceeds, failure fails the job, and a
run cancelled because main moved on falls through to the supersession check. It goes *above* the
supersession check, so "has main moved past us?" is asked after the wait, not before. Needs
`checks: read`; raise `timeout-minutes` to cover a full unfiltered CI run. *Considered: a merge
queue* (available to a public org repo; `ci.yml` would need `merge_group`). It keeps main green
rather than only gating deploys, but costs latency on every merge.

`deploy-migrations.md`'s steps slot in below this PR's, unchanged.

## PR 2 — The fleet's connections fit the session pooler

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

## PR 3 — The worker refuses a production config that would fail silently

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

## PR 4 — Smoke-test every deploy

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
PR 1 by dispatching against a fork or with the deploy step still stubbed: a branch dispatch is
refused, a worker dispatch ahead of `deploy/web` is refused, and a rollback logs the current
`deploy-service` rather than the target's. PR 2 by holding more session-mode connections than Pool
Size against the dev stack's pooler and confirming the worker keeps ticking.
