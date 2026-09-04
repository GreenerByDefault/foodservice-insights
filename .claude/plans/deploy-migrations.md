# Migrations run in the deploy workflow

## Context

`ARCHITECTURE.md` § Hosting has always said migrations run before the app updates; nothing has ever
run them, because [`actions/deploy-service`](../../.github/actions/deploy-service/action.yml) is a
stub until a provider is chosen. The question is where they run when it stops being one.

**In the deploy workflow, not as a pre-deploy command the provider runs inside the web image.** The
workflow already checks out the SHA it is deploying, which is a pnpm workspace — everything
migrating needs — whereas an image is the one place `@gbd/db` is *not* a workspace package.

This lands independently of [`deploy-docker-images.md`](deploy-docker-images.md) and before it: it
touches no Dockerfile, and the stubbed `deploy-service` means the only thing missing is a real
deploy call after the migrate step. One PR.

Facts marked **verified** were checked on 2026-09-03.

## The PR

A migrate step in `deploy.yml`'s `deploy-web` job, before it calls `deploy-service`. The job
already checks out the SHA; it gains `.github/actions/setup-node`, a
`DB_CONNECTION_STRING` secret, and `pnpm exec turbo run migrate` — which covers `@gbd/storage`'s
bucket creation as well as `@gbd/db`, and whose `dependsOn: ["^build"]` is what gets `@gbd/core`'s
`dist` built for [`env.ts`](../../packages/db/src/env.ts). Locally `pnpm migrate` is the same
command, so it keeps working unchanged.

This also ends production's dependence on Node's type stripping, which is what makes the image the
wrong place: `packages/db`'s migrations are TypeScript that `tsconfig.build.json` deliberately does
not emit, and under `node_modules` — where `@gbd/db` lives in an image —
`FileMigrationProvider`'s `import()` of one dies with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`
(**verified**), failing the deploy in the one step that cannot be rolled back. From a workspace
checkout `migrationFolder()` keeps pointing at source, and every caller of `migrateToLatest` stays
in-workspace — the script and `src/testing/` (**verified**).

*Rejected: emitting `migrations/` into `packages/db/dist/` so an image could run them. It works, but
it exists only to satisfy that one Node restriction, and buys a compile step and a second migration
path for something CI can do from the checkout it already has.*

It also deletes a provider requirement: nothing needs a per-service pre-deploy step, so Render's
paid-plans-only `preDeployCommand` and Railway's undocumented one stop bearing on the choice in
[`hosting-provider-notes.md`](hosting-provider-notes.md). The cost is a production database
credential in GitHub Actions secrets rather than only in the provider — `ARCHITECTURE.md`
§ Secrets management records it.

**A rollback must skip this step, and skipping is the safe direction.** Kysely errors —
`corrupted migrations: previously executed migration X is missing` — when the database has applied
a migration the checkout does not contain, which is precisely a `workflow_dispatch` at an older
SHA. It does not no-op, so an ungated step would fail every rollback in the step *before* the
deploy. That check is also what catches a genuinely mangled history, so gate the step rather than
teach it to tolerate a missing migration: run it on `push` and on a dispatch that left `sha` blank;
skip it whenever a SHA was named. Nothing ever calls `migrateDown` — § Hosting's fix-forward rule
is the whole rollback story for schema.

**The worker never migrates.** § Deployments' invariant is that the deployed worker is always the
side running behind, so the schema it needs is a subset of what the web deploy already applied.

A step inside `deploy-web`, not a job of its own: a separate job repeats the checkout and the pnpm
install to buy a row in the UI, and the point of moving migrations here is that "migrate, then
deploy" is adjacent and ordered in one file. Put the rollback reasoning on the step's `if:`.

**Open:** whether a GitHub runner can reach the database at all. Supabase's direct connection is
IPv6-only without the IPv4 add-on and runners are IPv4-only, so this wants the Supavisor
session-mode URL; Supabase's network restrictions, if ever enabled, do not fit a runner's dynamic
IP. Settle this first — it is the one thing that would send migrations back into the image.

## Verification

Against the dev Supabase stack, not an image: run the migrate step, then point a checkout that is
missing the latest migration at the same database and confirm the rollback gate is what stands
between that Kysely error and a failed deploy.
