# Notes toward a hosting provider

> **Status:** research notes, not a plan. `ARCHITECTURE.md` § Hosting is **Open: Railway vs Render vs
> DigitalOcean**, and these notes exist so that decision does not re-derive them. There are no PRs
> here for `/plan-advance` to fold in; this file is deleted when § Hosting records the decision.

## Context

Gathered while planning [`deploy-pipeline.md`](deploy-pipeline.md),
[`deploy-docker-images.md`](deploy-docker-images.md), and
[`deploy-skew-hardening.md`](deploy-skew-hardening.md). **Not a recommendation.**

Provider docs move. Treat everything here as of 2026-09-03 and re-check before committing.

## What this architecture needs from a provider

The deploy pipeline narrows the ask considerably. Because both services deploy from GitHub Actions
with the platform's git integration off, most of the provider's own CD machinery — watch paths, build
filters, check-suite gating — is **not** something we need. What is left:

1. **Deploy one named service at a named commit, from CI, with a real exit code.**
2. **A shutdown grace with a documented maximum**, generous enough to be worth draining into. An
   attempt averages ~5 minutes, so the useful range is minutes.
3. A per-service pre-deploy step for migrations, running with the service's own credentials.
4. `ARCHITECTURE.md` § Hosting's existing criteria: manual scaling, restarts, price, logging, alerts
   on CPU/memory/disk, simplicity over time.

Both providers researched can do all four. The differences are in how much is documented.

## Railway

- **Config-as-code has moved to Infrastructure as Code, and the new shape is better for us**: one
  `.railway/railway.ts` at the repo root describing the whole project — both services, volumes,
  domains, variables — instead of a per-service TOML file. TypeScript, which fits this repo. Existing
  `railway.toml` files are read until 2026-12-01; new services use IaC.
  ([config-as-code](https://docs.railway.com/config-as-code),
  [infrastructure-as-code](https://docs.railway.com/infrastructure-as-code))
- The IaC reference page **under-documents `service()`**. `drainingSeconds`, `overlapSeconds`,
  `watchPatterns`, `preDeployCommand`, `builder`, `dockerfilePath` all exist in the `railway` npm
  package's type definitions but not in the docs. Verified from source, not doc-guaranteed — worth an
  empirical check before relying on any of them.
- Shutdown: SIGTERM then SIGKILL, gap set by `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` /
  `deploy.drainingSeconds`. Also readable *inside* the container, so the worker could size its own
  drain from it — a nicer fit for the drain-grace check than a separately-declared value.
  `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` controls how long old and new co-run.
- Deploy at a commit from CI: `serviceInstanceDeployV2(serviceId, environmentId, commitSha)`. The
  official `railwayapp/config@v1` action is for IaC plan/apply, not code deploys; those go through the
  CLI. Project tokens use a `Project-Access-Token` header rather than `Bearer` — documented, easy to
  miss.
- Turning off git auto-deploy appears to be dashboard-only — no IaC field, CLI path, or GraphQL
  mutation found. Under our pipeline that is a one-time setup toggle rather than something we depend
  on continuously, so it is a minor wart rather than a blocker.
- Dockerfiles are auto-detected and **take precedence over any builder choice** — "Railway will always
  build with a Dockerfile if it finds one." Custom path via `RAILWAY_DOCKERFILE_PATH`.

## Render

- One `render.yaml` blueprint at the repo root declares both services: `type: web` and `type: worker`.
  GA. ([blueprint-spec](https://render.com/docs/blueprint-spec))
- `maxShutdownDelaySeconds`, **1–300, default 30** — a documented ceiling to size the drain grace
  against, and the clearest answer to requirement 2 of either provider.
- `autoDeployTrigger: commit | checksPass | off` per service, in the committed file. `off` is what the
  pipeline wants, and it is reviewable.
- Rolling deploys apply to background workers: new instance up, ~60s, SIGTERM to the old, SIGKILL
  after the shutdown delay. No documented way to get stop-then-start.
- `preDeployCommand` runs after build, before the new instance starts, on a separate instance whose
  filesystem changes do not persist. Paid plans only; per-service.
- **Do not set `rootDir`.** "Files outside your service's root directory are not available to the
  service at build time or at runtime," which makes a pnpm workspace unbuildable. Leave it unset and
  set `dockerContext: .` with `dockerfilePath: ./apps/<svc>/Dockerfile`. The docs contradict
  themselves on whether those two are root- or rootDir-relative; unset `rootDir` makes it moot.
- Deploy at a commit from CI: `render deploys create <srv> --commit <sha> --wait --confirm` with
  `RENDER_API_KEY`; `--wait` exits non-zero on failure. **Deploy hooks return 200 as soon as a deploy
  is queued**, so a bare `curl` step is green even when the deploy fails — use the CLI. No official
  GitHub Action.
- Blueprint changes are auto-applied on push and bypass build filters; auto-sync can be turned off.
  Background workers are not on the free plan.

## Common to both

- Both start-new-then-stop-old, so old and new worker co-run for a window. Fine here, and mildly good:
  the queue is `FOR UPDATE SKIP LOCKED` with leases, and `claimAndStart` refuses once `shuttingDown`
  is set, so the new worker takes the queue while the old finishes what it holds.
- Neither offers stop-then-start, so "only ever one worker" would have to be enforced in the app. We
  do not need it.
- Both run pre-deploy in a separate container whose filesystem changes do not persist — correct for
  migrations, useless for anything the service later reads off disk.
- DigitalOcean was not researched.

## Open

- **Open:** Railway's `drainingSeconds` default and maximum. Both undocumented; sources conflict
  between 0s and 3s for the default. It decides whether Railway can drain usefully at all, so it is
  the first thing to test.
- **Open:** Docker build context vs Root Directory on Railway — undocumented, needs an empirical test
  before committing to Dockerfiles there.
- **Open:** whether the old deployment keeps serving during a Railway pre-deploy command. The
  documented lifecycle implies yes; that is inference.
- **Open:** Render worker instance-type pricing; `/docs/instance-types` 404s.
- **Open:** DigitalOcean, if it stays a candidate.
