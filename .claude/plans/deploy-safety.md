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
that runs the full suite on the exact commit that lands, a connection budget
([`budget.ts`](../../packages/db/src/budget.ts)) whose test holds every pool, instance and role
limit within `max_connections`, `deploy-web` moving a `deploy/web` tag
on success, which names the commit `deploy-worker` deploys, dispatched from main only, production
secrets held only in a `production` Environment that deploys only from main (a dispatch of
another branch's `deploy.yml` runs without them), and every third-party action on the deploy path
pinned by SHA. Nothing deploys for real yet —
[`deploy-service`](../../.github/actions/deploy-service/action.yml) is a stub and
[`hosted-database.md`](hosted-database.md) has not landed — so each fix here is cheapest now.

Facts marked **verified** were checked on 2026-10-08.

Findings that went elsewhere rather than into a PR here:

- **One DigitalOcean app would redeploy the worker on every web push** — a note in
  [`hosting-provider.md`](hosting-provider.md) § After the decision.
- **Migration lock contention** — settled in [`hosted-database.md`](hosted-database.md), whose
  PR 2 owns the migration session's settings.
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

## Open from the merge queue

Checks for after it has run a while, not PRs yet.

- **Cache warming.** A PR run restores caches saved on main, but not those saved on the queue's
  `gh-readonly-queue/*` refs, and main's push run used to be what saved the pnpm, uv and
  Playwright caches. If the first lockfile change leaves every PR run cold, add a push job
  filtered to the lockfiles that only runs the setup actions.
- **`gh-stack`.** Whether it handles a queued base PR, since the next PR in a stack can only
  rebase once the one below it lands.

## PR 1 — The worker refuses a production config that would fail silently

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

## PR 2 — Smoke-test every deploy

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
