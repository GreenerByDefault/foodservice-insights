# Migrations run in the deploy workflow

## Context

`ARCHITECTURE.md` § Web deploys on every push says `deploy.yml` runs the migrations itself, before
it deploys. Nothing has ever run them. This is that step.

The ordering constraint against the image work is **resolved** — that plan landed as #258, and
`deploy-web`'s supersession guard is already in place with a comment reserving the slot below it
for this step ([`deploy.yml`](../../.github/workflows/deploy.yml)). The provider is still Open, so
[`deploy-service`](../../.github/actions/deploy-service/action.yml) remains a stub that warns and
exits 0; migrating against the real Supabase project is worth doing before that changes, and this
plan does not wait on it.

One PR.

Facts marked **verified** were checked on 2026-09-05.

## Forward migrations from here on, no reset

**Stop editing `001_initial_schema`. New schema changes are new numbered migration files, starting
at 002, and nothing resets the hosted database on deploy.**

The service isn't used yet, so a reset would be free — but the PoC that's about to run against the
real Supabase project is the one rehearsal this project gets for "an incremental migration runs
against a live hosted database with rows already in it," which is exactly what every migration
after the first user does. Staying on 001 until then means the first incremental migration ever
run against a hosted database is the one that runs against real data. Running `002`, `003`, … from
now on makes every deploy between here and launch a free rehearsal of that path instead.

It also drops a whole category of work this plan does not need: no destructive step in
`deploy.yml`, no gate to keep it off once real users exist, no `auth.users`-survives-a-schema-drop
trap, no Supabase-grants-reset trap. `scripts/supabase db reset` already does the reset job
locally, and that has not changed — this is only about what a hosted deploy does.

*Rejected: keep editing 001 and adding a gated reset step to `deploy.yml`, mirroring
`cfa-web-app`'s `railway.toml`.* That precedent resets into a *seeded* app (`db:seed` after);
here the equivalent (`seed:identity`) leaves one placeholder user and no reports, so every push
during the PoC would erase whatever was uploaded to it. A wired-in destructive deploy step also
needs a flag that must be turned off at exactly the right moment once real users exist — a manual
`db reset` when one is actually wanted has no such moment to miss.

*Rejected: squashing 002+ back into 001 later.* Nothing here forecloses it — it's still an option
if a design churns hard enough to be worth hand-squashing — but it isn't the default, and this
plan doesn't do it.

## The PR

A step in `deploy.yml`'s `deploy-web` job, below the supersession guard and above
`deploy-service`. The job already checks out the SHA; it gains
[`setup-node`](../../.github/actions/setup-node/action.yml) and `pnpm exec turbo run migrate`.
Locally `pnpm migrate` is the same command, so it keeps working unchanged.

**In the deploy workflow, not as a pre-deploy command the provider runs inside the web image.** The
workflow checks out a pnpm workspace — everything migrating needs — whereas an image is the one
place `@gbd/db` is *not* a workspace package. `packages/db`'s migrations are TypeScript that
`tsconfig.build.json` deliberately does not emit (**verified**), and under `node_modules`
`FileMigrationProvider`'s `import()` of one dies with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` — failing the deploy in the one step that cannot be
rolled back. From a workspace checkout `migrationFolder()` keeps pointing at source, and every
caller of `migrateToLatest` stays in-workspace.

*Rejected: emitting `migrations/` into `packages/db/dist/` so an image could run them. It works,
but it exists only to satisfy that one Node restriction, and buys a compile step and a second
migration path for something CI can do from the checkout it already has.*

**Six secrets, not one.** `turbo run migrate` runs in `@gbd/db` *and* `@gbd/storage`, whose
`env.ts` requires all five `S3_*` vars (**verified**) — an app missing the bucket is as broken as
one missing the schema, which is why they share a command. `turbo.json`'s `globalPassThroughEnv`
already lists all six (**verified**), so nothing there changes. The cost is production credentials
in GitHub Actions secrets rather than only in the provider; `ARCHITECTURE.md` § Secrets management
records it.

**Then `pnpm exec turbo run seed:identity`, ungated.** The app cannot serve a request without the
phase-one placeholder identity, and it's idempotent by way of `ON CONFLICT DO NOTHING`
(**verified**). Add this step to the deletion list in
[`seed.ts`](../../packages/db/src/seed.ts)'s header, which already enumerates the sites that go
when Supabase Auth lands.

**Migrations need their own connection settings.** `buildPoolConfig` sends
`-c statement_timeout=30000` as a startup parameter (**verified**), and that applies to migrations
too — a slow one aborts mid-deploy. `scripts/migrate.ts` should build its own handle via
`initializeDatabase` with a generous `statementTimeoutMs` instead of importing `DATABASE` from
`@gbd/db/env`.

**A rollback must skip the migrate step, and skipping is the safe direction.** Kysely errors —
`corrupted migrations: previously executed migration X is missing` (**verified**) — when the
database has applied a migration the checkout does not contain, which is precisely a
`workflow_dispatch` at an older SHA. It does not no-op, so an ungated step would fail every
rollback in the step *before* the deploy. That check is also what catches a genuinely mangled
history, so gate the step rather than teach it to tolerate a missing migration: run it on `push`
and on a dispatch that left `sha` blank; skip it whenever a SHA was named. Nothing ever calls
`migrateDown` — § Rollback's fix-forward rule is the whole story for schema. Put that reasoning on
the step's `if:`.

**The worker never migrates.** § Worker deploys only on demand's invariant is that the deployed
worker is always the side running behind, so the schema it needs is a subset of what the web
deploy already applied.

Steps inside `deploy-web`, not a job of their own: a separate job repeats the checkout and the
pnpm install to buy a row in the UI, and the point of moving migrations here is that "migrate,
then deploy" is adjacent and ordered in one file.

## Connectivity

Settling the previous draft's Open. Use the **Supavisor session-mode** URL — direct connections
(`db.<ref>.supabase.co`) are IPv6-only without the IPv4 add-on and GitHub runners are IPv4-only.
Transaction mode is the wrong tier regardless of the runner: we hold our own `pg` pool and set
session-level parameters. The app containers will want the same URL family, since neither
candidate provider is guaranteed IPv6 egress either. Supabase's network restrictions, if ever
enabled, do not fit a runner's dynamic IP.

**Verify the pooler accepts startup `options` before anything else.** `buildPoolConfig` passes
`-c statement_timeout=… -c idle_in_transaction_session_timeout=… -c idle_session_timeout=…` as the
connection's `options` parameter (**verified**), and PgBouncer-family poolers have historically
rejected unrecognized startup parameters outright. If Supavisor does, nothing connects — not the
migrations, not the web app, not the worker — and that is a larger blocker than the IPv4 question
this section replaces. A single `psql` with that `options` string against the session-mode URL
answers it.

## Known trap, not in scope

`README.md` § Add a database migration recommends `CREATE INDEX CONCURRENTLY`. It cannot work
today: `migrateToLatest` runs every migration inside one transaction, and Kysely only lifts that
under `disableTransactions` (**verified**). Forward migrations against a hosted database are what
makes this bite for real — flag it there when a migration first wants a concurrent index, rather
than fixing it here with nothing yet to exercise it.

## Verification

Against the dev Supabase stack first, then the real project.

1. Run the migrate step against a fresh database and confirm the schema, the bucket, and the
   placeholder identity all land.
2. Add a throwaway `002_*` migration, run migrate again, and confirm only it applies — the
   ordinary forward-migration path this plan commits to.
3. Point a checkout that is missing the latest migration at the same database and confirm the
   rollback gate is what stands between the Kysely corruption error and a failed deploy.

Stale elsewhere, worth fixing when convenient: `deploy-service/action.yml` and several plans still
cite `ARCHITECTURE.md` § Hosting, a heading fd5aad4 replaced with § Deployments and § Choosing a
host.
