# syntax=docker/dockerfile:1

# Builds the SvelteKit server in one stage, then copies the deployed result into a runtime
# image with nothing else in it — no Python, no migration entrypoint (CI runs those).
#
# Build from the repo root: `docker build -f apps/web/Dockerfile .`

# ------------------------------------------------------
# Node builder
# ------------------------------------------------------
FROM registry.access.redhat.com/ubi10/nodejs-24-minimal:latest AS node-builder

USER 0
RUN npm install -g pnpm@11.18.0

WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/storage/package.json packages/storage/package.json
# @gbd/browser-testing is a devDependency of @gbd/web, not a runtime one — its source never
# ships — but `uv sync`'s Python equivalent applies to pnpm too: `--frozen-lockfile` needs every
# workspace member the lockfile knows about to have a package.json on disk, or install fails.
COPY packages/browser-testing/package.json packages/browser-testing/package.json

RUN pnpm install --frozen-lockfile --filter @gbd/web...

COPY apps/web/src apps/web/src
COPY apps/web/static apps/web/static
COPY apps/web/start.js apps/web/start.js
COPY apps/web/tsconfig.json apps/web/tsconfig.json
COPY apps/web/vite.config.ts apps/web/vite.config.ts
COPY packages/core/src packages/core/src
COPY packages/core/tsconfig.json packages/core/tsconfig.json
COPY packages/core/tsconfig.build.json packages/core/tsconfig.build.json
COPY packages/db/src packages/db/src
COPY packages/db/tsconfig.json packages/db/tsconfig.json
COPY packages/db/tsconfig.build.json packages/db/tsconfig.build.json
COPY packages/storage/src packages/storage/src
COPY packages/storage/tsconfig.json packages/storage/tsconfig.json
COPY packages/storage/tsconfig.build.json packages/storage/tsconfig.build.json

# `--filter-prod`, not `--filter`: it walks only `dependencies`, so it builds @gbd/core, @gbd/db,
# and @gbd/storage (what the built server resolves from `node_modules` at runtime) without also
# building @gbd/browser-testing, whose source was never copied in.
RUN pnpm --filter-prod @gbd/web... run build
# Emits a self-contained directory with a real `node_modules`, so `@gbd/core` et al. resolve at
# runtime instead of being bundled — see `ssr.external` in vite.config.ts.
RUN pnpm deploy --legacy --prod --filter @gbd/web /deploy

# ------------------------------------------------------
# Web runtime
# ------------------------------------------------------
FROM registry.access.redhat.com/ubi10/nodejs-24-minimal:latest AS runtime

WORKDIR /app
COPY --from=node-builder /deploy /app

USER 1001

# `start.js`, never `build/index.js`: it derives `BODY_SIZE_LIMIT` from `MAX_UPLOAD_BYTES`
# before importing the built server, which is what raises adapter-node's 512KB default.
# Exec-form CMD runs node as PID 1 directly, with no intervening shell.
CMD ["node", "start.js"]
