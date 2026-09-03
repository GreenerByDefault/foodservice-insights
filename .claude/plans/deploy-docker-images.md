# Two Docker images

## Context

Nothing here is containerized for shipping — Docker appears only for local Supabase and the pinned
screenshot browser. Both services need an image.

Deliberately short. A dedicated sprint builds these; this records the constraints so that sprint does
not rediscover them. The deploy model that consumes these images is in
[`deploy-pipeline.md`](deploy-pipeline.md).

## Both services get a Dockerfile

The worker has no choice, and the web app gains from parity: one build mechanism to understand, no
provider-specific buildpack behaviour in the equation, and local `docker run` matching production for
both.

**The worker must be Docker.** It is polyglot: a Node parent spawning `PYTHON_BIN -m worker_child`
([`modes.ts`](../../apps/worker/src/modes.ts)), so one image needs Node 24 **and** Python 3.13 with
`worker_child` importable from the uv workspace. No buildpack — Railpack, Nixpacks, or Render's native
runtimes — does Node + uv in one image. [`categorization-cache.md`](categorization-cache.md) already
assumes parent and child ship together, and `.github/filters.yml` already says the lab "is not in the
worker image." Also needs a writable `WORKER_RUN_ROOT`.

**The web image has real packaging requirements a buildpack would satisfy only by accident.** It must
run `apps/web/start.js` — *not* `build/index.js`, which falls back to adapter-node's 512KB body limit
— and needs `apps/web/src/lib/reports/upload-limit.js`, `apps/web/build/`, and the externalized
`@gbd/*` `dist/` directories beside it ([`vite.config.ts`](../../apps/web/vite.config.ts)
`ssr.external`). Writing that down in a Dockerfile makes it explicit instead of incidental.

## Two traps that stay invisible until a deploy misbehaves

- **The container must `exec node` directly, never `pnpm ... start`.** Under
  `pnpm --filter @gbd/worker start`, pnpm becomes PID 1 and SIGTERM never reaches Node — which makes
  the whole drain design inert and presents as a worker bug. `ARCHITECTURE.md` already assumes "the
  parent is PID 1 in its container." This is process trees, not a platform quirk. Put the reasoning
  as a comment on the Dockerfile `CMD` and on `apps/worker/package.json`'s `start`.
- **`loadLocalEnv()` throws in a pruned image.** It calls `findRepoRoot()`, which walks up for
  `pnpm-workspace.yaml` and throws when there is none
  ([`packages/core/src/env.ts`](../../packages/core/src/env.ts)) — so the worker dies at import,
  before any clearer error can be raised. It should tolerate finding no repo root and load nothing; a
  platform injects real env vars, and the function is already a no-op when the file is absent.
  `resolvePythonBin()` ([`python-bin.ts`](../../apps/worker/src/python-bin.ts)) sits on the same call,
  sidestepped by an absolute `PYTHON_BIN`.

## Work

- `apps/worker/Dockerfile`, `apps/web/Dockerfile`, `.dockerignore`, build context at the repo root
  for both (the pnpm workspace needs the root manifest, lockfile, and `packages/*`).
- Spike `pnpm deploy --filter` for pruning the workspace into a shippable directory before committing
  to it.
- The two fixes above. The `findRepoRoot` one is a real code change and can land ahead of the images.

## Verification

Build both images locally and run the worker against the dev Supabase stack with
`WORKER_MODE=stubbed`. Confirm `docker stop` drains rather than killing — that is what proves the
PID 1 fix, and it is not observable any other way.
