# Notes toward a hosting provider

> **Status:** research notes, not a plan. `ARCHITECTURE.md` § Hosting is **Open: Railway vs Render vs
> DigitalOcean**, and these notes exist so that decision does not re-derive them. There are no PRs
> here for `/plan-advance` to fold in; this file is deleted when § Hosting records the decision.

## Context

Gathered while planning the deploy pipeline (now [`workflows/deploy.yml`](../../.github/workflows/deploy.yml)),
the two Dockerfiles, [`deploy-image-registry.md`](deploy-image-registry.md), and
[`deploy-skew-hardening.md`](deploy-skew-hardening.md). **Not a recommendation.**

Provider docs move. Treat everything here as of 2026-09-03 and re-check before committing.

## What this architecture needs from a provider

The deploy pipeline narrows the ask considerably. Because both services deploy from GitHub Actions
with the platform's git integration off, most of the provider's own CD machinery — watch paths, build
filters, check-suite gating — is **not** something we need. What is left:

1. **Deploy one named service at a named image tag or digest, from CI, with a real exit code.**
   `deploy.yml` already builds both images in CI and pushes them to GHCR tagged with the commit
   SHA, so neither provider builds anything — this replaces "at a named commit" from the earlier
   draft of these notes, and the two sections below are re-evaluated against it rather than against
   a commit-based deploy call.
2. **A shutdown grace with a documented maximum**, generous enough to be worth draining into. An
   attempt averages ~5 minutes, so the useful range is minutes.
3. `ARCHITECTURE.md` § Hosting's existing criteria: manual scaling, restarts, price, logging, alerts
   on CPU/memory/disk, simplicity over time.

Both providers researched can run a prebuilt image; the differences are in how well digest-pinned
deploys and immutable tags are documented, which now bears directly on requirement 1.

## Railway

- **Config-as-code has moved to Infrastructure as Code, and the new shape is better for us**: one
  `.railway/railway.ts` at the repo root describing the whole project — both services, volumes,
  domains, variables — instead of a per-service TOML file. TypeScript, which fits this repo. Existing
  `railway.toml` files are read until 2026-12-01; new services use IaC.
  ([config-as-code](https://docs.railway.com/config-as-code),
  [infrastructure-as-code](https://docs.railway.com/infrastructure-as-code))
- The IaC reference page **under-documents `service()`**. `drainingSeconds`, `overlapSeconds`,
  `watchPatterns`, `builder`, `dockerfilePath` all exist in the `railway` npm
  package's type definitions but not in the docs. Verified from source, not doc-guaranteed — worth an
  empirical check before relying on any of them.
- Shutdown: SIGTERM then SIGKILL, gap set by `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` /
  `deploy.drainingSeconds`. Also readable *inside* the container, so the worker could size its own
  drain from it — a nicer fit for the drain-grace check than a separately-declared value.
  `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` controls how long old and new co-run.
- **Image source appears to be dashboard-configured, not IaC.** No `.railway/railway.ts` field for
  pointing a service at a registry image was found. The documented CI path is a *mutable* tag plus
  `railway redeploy` — the model requirement 1 needs is a tag or digest deploy call from CI, and
  that is not what this is.
- **Open:** can Railway accept a digest reference (`@sha256:…`) at all — undocumented, sources
  cover only mutable tags (`:latest`, `:production`) — and can the service's image be set or
  changed outside the dashboard, from CI?
- Project tokens use a `Project-Access-Token` header rather than `Bearer` — documented, easy to
  miss, and still relevant to whatever API call ends up setting the image.
- The build-context guidance below this line in the previous draft (Dockerfile auto-detection,
  `RAILWAY_DOCKERFILE_PATH`, git auto-deploy) is moot now: Railway never builds under this design.

## Render

- One `render.yaml` blueprint at the repo root declares both services: `type: web` and `type: worker`.
  GA. ([blueprint-spec](https://render.com/docs/blueprint-spec))
- `maxShutdownDelaySeconds`, **1–300, default 30** — a documented ceiling to size the drain grace
  against, and the clearest answer to requirement 2 of either provider.
- **`runtime: image`, not a Dockerfile build.** `image: {url, creds}` in the blueprint; `creds` is
  omitted entirely for a public package. Digest references are documented as accepted
  (`url: …@sha256:…`), which is exactly what requirement 1 asks for. `autoDeployTrigger: off` still
  applies, and is what stops Render from redeploying on its own when a tag's bytes change — an
  image-backed service is documented as *not* auto-redeploying when its tag moves, which is the
  behavior this design wants regardless.
- `preDeployCommand` and the `dockerContext`/`dockerfilePath`/`rootDir` guidance from the previous
  draft no longer apply — [`deploy-migrations.md`](deploy-migrations.md) runs migrations from the
  GitHub Actions checkout, not a provider pre-deploy step, and Render never builds under this
  design.
- Rolling deploys apply to background workers: new instance up, ~60s, SIGTERM to the old, SIGKILL
  after the shutdown delay. No documented way to get stop-then-start.
- Deploy call from CI, revised for an image: likely still `render deploys create <srv> --wait
  --confirm`, but **open** whether the CLI accepts an image tag/digest override the way it accepts
  `--commit` for a Git-backed service, or whether an image-backed service only redeploys by editing
  `image.url` in the blueprint and pushing that. **Deploy hooks return 200 as soon as a deploy is
  queued**, so a bare `curl` step would be green even when the deploy fails — use the CLI once this
  is settled. No official GitHub Action.

## Common to both

- Both start-new-then-stop-old, so old and new worker co-run for a window. Fine here, and mildly good:
  the queue is `FOR UPDATE SKIP LOCKED` with leases, and `claimAndStart` refuses once `shuttingDown`
  is set, so the new worker takes the queue while the old finishes what it holds.
- Neither offers stop-then-start, so "only ever one worker" would have to be enforced in the app. We
  do not need it.
- Both are, at minimum, GHCR-compatible for a public image with no credential — neither's docs
  raise a barrier to anonymous pulls specifically, though this is worth an empirical check before
  relying on it (§ Open).
- DigitalOcean was not researched.

## Open

- **Open:** Railway's `drainingSeconds` default and maximum. Both undocumented; sources conflict
  between 0s and 3s for the default. It decides whether Railway can drain usefully at all, so it is
  the first thing to test.
- **Open:** can Railway deploy a GHCR image by digest from CI at all, and can the image be set
  outside the dashboard? Replaces the old build-context Open item, which no longer applies.
- **Open:** does Render's CLI accept an image tag/digest override for redeploying an image-backed
  service, or does changing the image mean editing and pushing the blueprint?
- **Open:** confirm both providers actually pull an anonymous public GHCR image without a
  configured credential — the docs don't say either way.
- **Open:** Render worker instance-type pricing; `/docs/instance-types` 404s.
- **Open:** DigitalOcean, if it stays a candidate.

## Once a provider is chosen

- **The deployed commit is already on the image**, not something to normalize from a
  provider-injected variable: [`build-image`](../../.github/actions/build-image/action.yml) labels
  every build `org.opencontainers.image.revision=<sha>`, and
  [`deploy-image-registry.md`](deploy-image-registry.md) puts the resolved digest in the deploy
  run's log and the annotated `deploy/worker` tag. A service can still log it at boot by
  reading that label if that turns out to be useful; it no longer needs reconciling between
  `RAILWAY_GIT_COMMIT_SHA` and `RENDER_GIT_COMMIT`, since neither provider builds anymore.
