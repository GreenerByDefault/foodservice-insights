# Two Docker images

## Context

Nothing here is containerized for shipping — Docker appears only for local Supabase and the
pinned screenshot browser. Both services need an image.

The deploy pipeline that consumes them —
[`workflows/deploy.yml`](../../.github/workflows/deploy.yml) and
[`actions/deploy-service`](../../.github/actions/deploy-service/action.yml) — already exists; its
composite deploy step is a stub until a hosting provider is chosen, and these images are what
fills it in.

**CI builds the image once per commit and pushes it to GHCR; the provider never builds.** See
[`deploy-image-registry.md`](deploy-image-registry.md) for why — in short, a provider that builds
from a checkout cannot deploy bytes that already ran, which a rollback and a later staging
environment both need, and the registry a public repo needs is free and needs no credential. Each
Dockerfile still does the whole build from source; only *where* that build runs, and what happens
to its output, has changed.

Facts below marked **verified** were checked on 2026-09-03 against `linux/amd64`. Base images and
RPM streams move; re-check before trusting a version number.

## Both services get a Dockerfile

The worker has no choice, and the web app gains from parity: one build mechanism to understand,
no provider-specific buildpack behaviour in the equation, and local `docker run` matching
production for both.

**The worker must be Docker.** It is polyglot: a Node parent spawning `PYTHON_BIN -m worker_child`
([`modes.ts`](../../apps/worker/src/modes.ts)), so one image needs Node and Python in the same
container. No buildpack — Railpack, Nixpacks, or Render's native runtimes — does Node + uv in one
image. [`categorization-cache.md`](categorization-cache.md) already assumes parent and child ship
together, and `.github/filters.yml` already says the lab "is not in the worker image." Also needs
a writable `WORKER_RUN_ROOT`.

**The web image has real packaging requirements a buildpack would satisfy only by accident.** It
must run `apps/web/start.js` — *not* `build/index.js`, which falls back to adapter-node's 512KB
body limit — and `start.js` reads `apps/web/src/lib/reports/upload-limit.js` off disk at boot. The
`@gbd/*` packages are left as bare specifiers in the built server chunks
([`vite.config.ts`](../../apps/web/vite.config.ts) `ssr.external`), so they must resolve from
`node_modules` at runtime. Writing that down in a Dockerfile makes it explicit instead of
incidental.

## Base images: UBI 10's language images

`registry.access.redhat.com/ubi10/nodejs-24-minimal` and `ubi10/python-314-minimal`, pinned by
digest. Red Hat rebuilds them against RHEL's errata stream and publishes them with no Docker Hub
pull limit and no account, which is the supply-chain property we are buying: a base whose CVE
backports are somebody's job, for both runtimes rather than just the OS underneath them.

**Verified:** Node 24.19.0 with `node` and `npm` at `/usr/bin`, and CPython 3.14.7. Both images
already run as uid 1001, so the non-root requirement and a writable `WORKER_RUN_ROOT` are the
image's problem rather than ours. `npm install -g pnpm@<the version in `packageManager`>` works on
the Node image.

**`ubi10/python-314-minimal` is `ubi-minimal` plus the `python3.14` RPM** and a venv at
`/opt/app-root` — **verified**, same `python3.14-3.14.7-2.el10_2` build that
`microdnf install python3.14` fetches. So the worker's runtime stage can obtain the *identical*
interpreter without copying one out of the Python builder.

*Rejected: `ubi10/nodejs-24`, the S2I builder image — 956MB against `-minimal`'s 342MB, for an
assemble/run framework a hand-written Dockerfile does not use.*

*Rejected: `ubi-minimal` plus the `nodejs24` and `python3.14` RPMs. It is ~20MB smaller, but the
`nodejs24` RPM installs `node-24`, `npm-24`, `npx-24` with no `node` on `PATH` — which breaks every
`#!/usr/bin/env node` shebang npm writes — and leaves the image running as root. Both are things
the language image has already solved.*

*Rejected: a uv-managed CPython (`uv python install`). It gets any version we like, but adds
python-build-standalone to the supply chain we picked UBI to shrink.*

## Two builder stages that never meet

The Node and Python halves of the worker are built independently and only meet in the runtime
stage, as `COPY --from` of two finished artifacts. Neither builder needs the other's toolchain.

- **Python builder** — `ubi10/python-314-minimal`, plus uv pinned by digest from
  `ghcr.io/astral-sh/uv`. `UV_PYTHON_DOWNLOADS=never` and `--python /usr/bin/python3.14` are what
  make the base image worth choosing: uv resolves against Red Hat's interpreter instead of
  fetching its own. `UV_PROJECT_ENVIRONMENT=/opt/venv`, then
  `uv sync --locked --no-dev --no-editable --package worker-child`.
- **Node builder** — `ubi10/nodejs-24-minimal`, plus pnpm from `npm install -g`. Install, build,
  then `pnpm deploy --legacy --prod --filter <pkg> <dir>`, which emits a self-contained directory
  with a real `node_modules` — **verified** for `@gbd/worker`.
- **Worker runtime** — the Node image, `microdnf install python3.14`, and the two artifacts copied
  in. **Verified end to end at 110MB:** `node -v` 24.19.0, `/opt/venv/bin/python` 3.14.7,
  `import worker_child.testing` working, uid 1001, and no uv or build tooling left in the image.
- **Web runtime** — the Node image and nothing else.

Two details that are load-bearing rather than incidental:

- **`--no-editable` is what lets `python/` not ship.** It installs real copies of `worker_child`
  and `gbd_foodservice_insights` into `site-packages` instead of linking back to source.
- **The venv's `pyvenv.cfg` names `/usr/bin/python3.14` by absolute path**, so the runtime has to
  carry that exact path. That is why the runtime installs the RPM rather than copying an
  interpreter out of the Python builder — the RPM puts it where the venv already expects it.

*Rejected: copying the interpreter out of the Python stage (`/usr/lib64/python3.14`, the shared
library, the stdlib) instead of installing the RPM. It saves one `microdnf` call and turns a
supported package into a hand-assembled one.*

## The allowlist is the `COPY` lines, not a `.dockerignore`

Each stage names what it wants, one `COPY` per tracked entry — `apps/worker/src`,
`apps/worker/package.json`, and so on — rather than `COPY .` behind an ignore file. The allowlist
then sits in the Dockerfile beside the thing it feeds, there is no second file whose semantics
have to be right for the first one to be safe, and nothing depends on the provider's builder
honouring a per-Dockerfile ignore file, which is undocumented for either candidate.

The context costs nothing to leave unfiltered: the provider builds from a git checkout, which is
786 tracked files. A local build is the dirty case — a working tree here is ~487MB, nearly all of
it `node_modules` and `.venv` — and BuildKit still walks all of it.

Two things make per-entry `COPY` the right granularity rather than per-directory:

- **`COPY` copies symlinks verbatim, without following them** — **verified**. pnpm links
  `apps/worker/node_modules/@gbd/core` at `packages/core`, outside the copied tree, so
  `COPY apps/worker apps/worker` from a working tree lands a *dangling* `@gbd/core` in the image
  that then shadows whatever `pnpm install` creates. `COPY apps/worker/src` cannot.
- **A directory copy also picks up stale local build output** — `apps/worker/dist`,
  `apps/web/build`, `.svelte-kit` — which busts the layer cache on every local rebuild and can
  ship an artifact newer than the source that built it.

Today every such artifact is a *sibling* of a tracked entry rather than nested inside one, so
per-entry `COPY` needs no ignore file at all — **verified** across `apps/`, `packages/`, and
`python/`. That is a property of the current tree, not an invariant. A four-line `.dockerignore`
holding only artifacts never wanted in any image (`**/node_modules`, `**/dist`, `**/__pycache__`,
`.venv`) makes it one, and cannot drift the way an allowlist would, because nothing in it is ever
a thing a service needs.

*Rejected: an allowlist `.dockerignore` (`*`, then `!` lines). It works — BuildKit re-includes
through an excluded parent, unlike git — but it duplicates the `COPY` lines in a second file with
different matching rules, and only the `COPY` lines decide what is in the image.*

*Rejected: `COPY --parents packages/*/package.json ./` to collapse the manifests-before-install
cache layer into one line. It works, but needs `# syntax=docker/dockerfile:1-labs`, so every build
pulls a frontend image from Docker Hub — against the reason we are on UBI at all. One explicit
`COPY` per package instead.*

Beyond the per-service source, each image needs the pnpm workspace's root manifest, lockfile,
`pnpm-workspace.yaml`, and `tsconfig.base.json`; the web image needs `packages/browser-testing` (a
devDependency, so a full `pnpm install` wants it present); and the worker needs the Python
workspace root plus one thing that looks like a mistake:

**`python/lab/pyproject.toml` must be copied into the Python builder**, even though the lab ships
nothing and `filters.yml` says so. `uv.lock` covers every workspace member, and `uv sync --locked`
fails with "the lockfile needs to be updated" when a member's manifest is absent. The manifest
alone is enough — **verified** — so the lab's source stays out.

## Traps that stay invisible until a deploy misbehaves

- **The container must `exec node` directly, never `pnpm ... start`.** Under
  `pnpm --filter @gbd/worker start`, pnpm becomes PID 1 and SIGTERM never reaches Node — which
  makes the whole drain design inert and presents as a worker bug. `ARCHITECTURE.md` already
  assumes "the parent is PID 1 in its container." This is process trees, not a platform quirk. Put
  the reasoning as a comment on the Dockerfile `CMD` and on `apps/worker/package.json`'s `start`.
- **`resolvePythonBin()` calls `findRepoRoot()`**
  ([`python-bin.ts`](../../apps/worker/src/python-bin.ts)), which throws where there is no
  `pnpm-workspace.yaml`. An absolute `PYTHON_BIN` returns before the call, which is why
  `/opt/venv/bin/python` is absolute rather than conventional. `loadLocalEnv()` sat on the same
  call and already tolerates it ([`env.ts`](../../packages/core/src/env.ts)).

## PR 1 — `apps/worker/Dockerfile`

The three stages above, its `COPY` allowlist, the shared `.dockerignore`, and the `CMD` comment.
Repo root as build context.

## PR 2 — `apps/web/Dockerfile`

Node builder and Node runtime, no Python, and no migration entrypoint —
[`deploy-migrations.md`](deploy-migrations.md) puts migrations in CI instead.

## Verification

Build both images locally and run the worker against the dev Supabase stack with
`WORKER_MODE=stubbed`. Confirm `docker stop` drains rather than killing — that is what proves the
PID 1 fix, and it is not observable any other way.

