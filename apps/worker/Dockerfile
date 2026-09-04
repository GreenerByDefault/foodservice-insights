# syntax=docker/dockerfile:1

# Builds the worker's Node parent and Python child in independent stages that never share a
# toolchain, then assembles both artifacts into one runtime image.
#
# Build from the repo root: `docker build -f apps/worker/Dockerfile .`

# ------------------------------------------------------
# Python builder
# ------------------------------------------------------
FROM registry.access.redhat.com/ubi10/python-314-minimal:latest AS python-builder
COPY --from=ghcr.io/astral-sh/uv@sha256:8b940d3a9d65bed080436972241af2e21c84b5e8c9193f7014ed71479ee795ff /uv /usr/bin/uv

# Base image default is uid 1001; root only for writing /opt/venv (COPY below always writes as
# root, and this stage's output is copied out by path rather than run).
USER 0
WORKDIR /src

COPY pyproject.toml uv.lock ./
COPY python/insights/pyproject.toml python/insights/pyproject.toml
COPY python/worker_child/pyproject.toml python/worker_child/pyproject.toml
# The lab ships nothing, but `uv.lock` covers every workspace member, and `uv sync --locked`
# fails "the lockfile needs to be updated" if a member's manifest is missing.
COPY python/lab/pyproject.toml python/lab/pyproject.toml

COPY python/insights/gbd_foodservice_insights python/insights/gbd_foodservice_insights
COPY python/worker_child/worker_child python/worker_child/worker_child

# `--no-editable` installs real copies into site-packages instead of linking back to `/src`,
# which is what lets `python/` not ship in the runtime stage.
ENV UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/opt/venv
RUN uv sync --locked --no-dev --no-editable --package worker-child --python /usr/bin/python3.14

# ------------------------------------------------------
# Node builder
# ------------------------------------------------------
FROM registry.access.redhat.com/ubi10/nodejs-24-minimal:latest AS node-builder

USER 0
RUN npm install -g pnpm@11.18.0

WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/email/package.json packages/email/package.json
COPY packages/storage/package.json packages/storage/package.json

RUN pnpm install --frozen-lockfile --filter @gbd/worker...

COPY apps/worker/src apps/worker/src
COPY apps/worker/tsconfig.json apps/worker/tsconfig.json
COPY apps/worker/tsconfig.build.json apps/worker/tsconfig.build.json
COPY packages/core/src packages/core/src
COPY packages/core/tsconfig.json packages/core/tsconfig.json
COPY packages/core/tsconfig.build.json packages/core/tsconfig.build.json
COPY packages/db/src packages/db/src
COPY packages/db/tsconfig.json packages/db/tsconfig.json
COPY packages/db/tsconfig.build.json packages/db/tsconfig.build.json
COPY packages/email/src packages/email/src
COPY packages/email/tsconfig.json packages/email/tsconfig.json
COPY packages/email/tsconfig.build.json packages/email/tsconfig.build.json
COPY packages/storage/src packages/storage/src
COPY packages/storage/tsconfig.json packages/storage/tsconfig.json
COPY packages/storage/tsconfig.build.json packages/storage/tsconfig.build.json

RUN pnpm --filter @gbd/worker... run build
# Emits a self-contained directory with a real `node_modules`, not workspace symlinks — so the
# `COPY --from=node-builder` below can't land a dangling `@gbd/core` pointing back at `packages/`.
RUN pnpm deploy --legacy --prod --filter @gbd/worker /deploy

# ------------------------------------------------------
# Worker runtime
# ------------------------------------------------------
FROM registry.access.redhat.com/ubi10/nodejs-24-minimal:latest AS runtime

USER 0
# The RPM, not a copy of the Python builder's interpreter: the venv's `pyvenv.cfg` names
# `/usr/bin/python3.14` by absolute path, and the RPM is what puts it there.
RUN microdnf install -y python3.14 && microdnf clean all

WORKDIR /app
COPY --from=python-builder /opt/venv /opt/venv
COPY --from=node-builder /deploy /app

ENV PYTHON_BIN=/opt/venv/bin/python
ENV WORKER_RUN_ROOT=/tmp/worker-runs
RUN mkdir -p "$WORKER_RUN_ROOT" && chown 1001:0 "$WORKER_RUN_ROOT"

USER 1001

# `exec node` directly, never `pnpm ... start` — under pnpm, pnpm is PID 1 and SIGTERM never
# reaches Node, which would make the drain design in `worker.ts` inert.
CMD ["node", "dist/main.js"]
