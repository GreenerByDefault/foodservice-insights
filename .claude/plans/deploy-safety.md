# Deploy safety

## Context

A review on 2026-10-08 of what can break when deploying web and worker, on top of the mitigations
already in place: image-per-commit promotion, `deploy-web`'s supersession guard, the
worker-runs-behind invariant, the drain with its `config.ts` relations, migrations from the
workspace rather than the image, deploys that only ever fix forward, report pages that reload once
their poll is answered by another deploy, a web server that refuses to start without its config
(`assertConfigured`, from `init` in [`hooks.server.ts`](../../apps/web/src/hooks.server.ts)),
`ts-db-types` migrating the base branch first (in the merge queue, the entry ahead) so that
Kysely refuses a migration out of order or missing, as the hosted database would, a merge queue
that runs the full suite on the exact commit that lands, and `deploy-web` moving a `deploy/web`
tag on success, which names the commit `deploy-worker` deploys, dispatched from main only. Nothing deploys for real yet —
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
- *Rejected: deploying once main's CI passes (`workflow_run` on `CI`).* It gates deploys but
  still lets a bad combination of PRs land, and a red main then blocks every deploy until it is
  fixed forward. The merge queue keeps that commit off main instead, for the same deploy
  latency: the queue's run replaces main's. What it costs is merge latency (a PR reaches main a
  full CI run after it is queued) and flakes that eject a PR rather than delay a deploy.
- *Rejected: CI on push to main as well as in the queue.* The queue already tested the exact
  commit that lands, and the ruleset has no bypass actors (**verified** 2026-10-12), so a second
  run tests nothing new.
- *Rejected: checking config in `/health`.* The web app validates config at startup instead —
  `assertConfigured` builds every lazy handle (database, blob store, emailer, logger, and the
  Supabase project in `supabase` mode), so a missing variable crashes the server, as the worker's
  config does, and the deploy's health check never passes. It checks handles rather than a list
  of variable names, so a variable added to an existing handle needs no change there; a new
  handle needs one line. And it leaves `/health` free for `observability-vendors.md`'s split into
  liveness and a dependency check.

## PR 1 — Production secrets live in a `production` Environment

Coupled to repo settings, so it lands with them. A human has created the `production` Environment
but not yet configured it.

`deploy-migrations.md` adds six production secrets; as repo secrets they reach any `pull_request`
run from a same-repo branch, so any PR — agent-authored included — can edit `ci.yml` and print
them. Both deploy jobs declare `environment: production`; the Environment limits deployment
branches to `main` and holds the secrets. The secrets living only there is the boundary: a
dispatch runs the chosen branch's own `deploy.yml`, which can drop the declaration and
`deploy-worker`'s branch check alike, but then has no credentials. The branch rule and that check
stop honest mistakes; keep both.

While these jobs gain prod credentials (on top of `packages: write` and `contents: write`), pin
their third-party actions by SHA — including those inside the composite actions they call
(`deploy-service`'s `docker/setup-buildx-action`). Dependabot's `github-actions` ecosystem already
keeps such pins current.

## Open from the merge queue

Checks for after it has run a while, not PRs yet.

- **Cache warming.** A PR run restores caches saved on main, but not those saved on the queue's
  `gh-readonly-queue/*` refs, and main's push run used to be what saved the pnpm, uv and
  Playwright caches. If the first lockfile change leaves every PR run cold, add a push job
  filtered to the lockfiles that only runs the setup actions.
- **`gh-stack`.** Whether it handles a queued base PR, since the next PR in a stack can only
  rebase once the one below it lands.

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
PR 1 by dispatching from a branch whose workflow declares the Environment and confirming it is
refused before any step runs. PR 2 by holding more session-mode connections than Pool Size
against the dev stack's pooler and confirming the worker keeps ticking.
