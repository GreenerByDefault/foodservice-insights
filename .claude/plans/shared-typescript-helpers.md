# Shared TypeScript helpers

## Context

A sweep of `apps/*`, `packages/*` and `tests/e2e` for helpers written more than once, checked
against where each copy is imported from and whether the browser bundle could reach it, then a
design review of where each should live (2026-10-21, re-checked against `main` on 2026-10-25).
What is worth a single copy:

- **A Postgres-clock `msAgo` with a JS-clock name.** `apps/worker/src/sql.ts` exports `msAgo(ms)`
  as `now() - make_interval(...)`, byte-identical to `dbMsAgo` in
  `packages/db/src/testing/fixtures/values.ts`, whose header warns against confusing it with
  `@gbd/core`'s `msAgo`, which returns a JS `Date`. The worker depends on both packages, so the
  production copy carries the confusable name and the safely named one is test-only. Importers of
  the worker's: `sweeps/converge.ts` (production), `sweeps/notifications.test.ts`,
  `testing/attempt-timeline.ts`.
- **`Breakable<T>` and `withBreakable` live in `@gbd/db/testing`** (`src/testing/breakable.ts`)
  and are pure. `packages/email/src/testing/breakable.ts` and `packages/storage/src/testing/
  breakable.ts` re-export the type from there; the worker imports both from `@gbd/db/testing`.
  A generic test primitive resolves through the database package's entry point.
- **`RUN_STALE_AFTER_MS = 2 * 60 * 60 * 1000` is written four times**, each with a comment
  promising it is "the same bound as" another: `apps/grafana/src/testing/run-data-source.ts:11`,
  `packages/db/src/testing/run-database.ts:79`, `packages/storage/src/testing/run-bucket.ts:20`,
  and `STALE_AFTER_MS` in `tests/e2e/scripts/containers.ts:60`. Only the number is shared: db's
  names use `_` (its `assertOwnedName` forbids hyphens) and the containers are keyed by Docker
  label, so there is no shared naming scheme to extract.
- **Three browser-side mirrors of `@gbd/db` constants.** `apps/web/src/lib/orgs/name.ts:11-14`
  and `lib/account/display-name.ts:10-14` copy `MAX_ORGANIZATION_NAME_LENGTH` and
  `MAX_DISPLAY_NAME_LENGTH`; `apps/web/src/params.ts:4-11` inlines `ORGANIZATION_SLUG_PATTERN`.
  Each says importing a value from `@gbd/db` "would pull `pg` into the browser bundle", and each
  is pinned by a test. `packages/db/src/constraints.ts` has no imports. The client build already
  bundles `@gbd/core` values from `dist/*.js`, and `vite.config.ts`'s `ssr.external` externalizes
  `@gbd/db` and its subpaths for SSR, so a pure subpath is reachable from the browser with no
  build change.
- **A second unique-test-email helper.** `aTestEmailAddress(label)` in `@gbd/email/testing`
  carries the RFC 2606 rationale; `anEmail()` in `apps/web/src/lib/server/testing/email.ts`
  duplicates it for two tests, and four web test sites inline `${crypto.randomUUID()}@example.test`.
  `packages/browser-testing/src/identity.ts`'s `gotrue.example.test` is not a duplicate: the
  domain is what `sweepStaleGoTrueUsers` deletes by. The three inline sites in `packages/db`
  cannot import `@gbd/email`.
- **Exports with no importer outside their package**, after #643 trimmed `@gbd/db`'s: in
  `@gbd/storage` `ensureBucket`, `isBucketAlreadyExistsError`, `isNotFoundError`, `headObject`,
  `ObjectMetadata`; in `@gbd/storage/testing` `unreachableBlobStore`; in `@gbd/email`
  `emailRequest`, `mailpitTransport`, `postmarkTransport`, `providerTransport`; in
  `@gbd/email/testing` `breakableEmailer`, `clearMailbox`, `waitForEmails`, `allMessages` and the
  six `a*`/`an*` message fixtures. `packages/email/README.md:37` names `waitForEmails`. Package
  scripts import by relative path, so none depends on an entry.
- **Eight `tsconfig.json`s repeat the same `nodenext` override with the same three-line comment.**
  `apps/web` is the exception, extending `$app/tsconfig`, whose `module: esnext` /
  `moduleResolution: bundler` would win over the base in any case. `turbo.json`'s
  `globalDependencies` and `filters.yml`'s `ts_workspace` both name `tsconfig.base.json`, so a
  new shared tsconfig would have to join both lists.
- **Two stale comments.** `packages/core/src/index.ts:1-4` calls `APP_NAME` "a placeholder value
  only to set up packages/core"; it is the product name, used in every email.
  `packages/browser-testing/src/playwright-config.ts:42-49` documents `webServer.cwd` and `env`
  for "`tests/e2e`, which runs `apps/web`'s build from outside that package"; `tests/e2e` runs a
  container now and neither caller passes either option.

## Decisions

- **Shared test primitives go to `@gbd/core/testing`; a value production code needs goes to the
  package that owns the fact.** So `Breakable`/`withBreakable` and `RUN_STALE_AFTER_MS` move to
  core's testing entry (already Node-only, via pino), while `dbMsAgo`/`dbMsFromNow` move to
  `@gbd/db`'s root, since `converge.ts` is production code. `DB_NOW` stays testing-only: it has
  no production user, and #643's bar was no unused root exports.
- **`@gbd/db/constraints` is a new subpath, and the root keeps re-exporting.** Server importers
  (`lib/server/orgs/slug.ts`, `failure-copy.ts`, `packages/db/tests/organization.test.ts`) are
  untouched; browser code imports the subpath. `constraints.ts`'s header says the subpath exists
  for browser bundles. The three mirrors and their pinning tests go; `params.test.ts`'s "every
  derived slug is accepted" test stays, since it pins the pattern against
  `deriveOrganizationSlug`, not against a copy.
- **One `aTestEmailAddress`, in `@gbd/email/testing`, where it already is.** Delete `anEmail`;
  repoint the web's sites. Leave `packages/db`'s three inline addresses: a core helper to serve
  three lines is the generalization AGENTS.md warns against. Leave `identity.ts`.
- **Trim the exports listed above.** Keep `withTemporaryOrganization` (`docs/typescript.md:81`
  and `packages/storage/README.md:42` direct consumers to it), `createJsonLogger`
  (`core/testing.ts` imports it from `./log.ts`, the entry module itself) and every type that
  appears in a kept signature. `waitForEmails` goes because its only would-be consumer, below, is
  not being built.
- **Flip `tsconfig.base.json` to `nodenext` rather than add a base.** The eight overrides and
  their comment collapse into the base, with the rationale once; each file keeps its own
  `types: ["node"]` where it has one (the base's `types: []` is what keeps `@gbd/core`'s browser
  code honest). No new file, so nothing to add to turbo or the filters. Optional, last.
  *Rejected: a root `tsconfig.node.json`* (the two-list trap above). *Rejected: a shared vitest
  preset.* `environment: 'node'` is the default and the other two settings are two lines; a preset
  would need a relative import out of a package or a runtime vitest dependency in core.
- **Not done, after reading each site:**
  - *A generic `waitUntil` in core.* Six poll loops exist, but only one pair duplicates
    (`waitForEmails` and `apps/web/e2e/lib/emailed-code.ts`). The others are lifecycle loops in
    non-test files with diagnostics a predicate cannot carry: `browser-container.ts` dumps the
    container's logs if it exits mid-wait, `local-grafana.ts` counts attempts, `concurrency.ts`
    checks "settled before blocked" between polls, and the worker's `wait-until.ts` sizes its
    constants against the worker's own convergence. Even `emailed-code.ts` would lose its "here is
    the HTML that did arrive" error.
  - *A `runResourceName`/`isStaleRunResource` pair.* Two consumers share the scheme; the other
    two do not (above).
  - *Moving route builders into `@gbd/core`.* See [`result-email-links.md`](result-email-links.md).
  - *The web app's env mapping versus the packages' `env.ts`* (S3's five fields twice, the
    emailer's six twice, the database's thrice). The Vite/Node split is documented on each
    `env.ts`, and a reader-function helper would still leave two call sites per package to
    update when a variable is added. Leave.

## PR 1 — Values move to the package that owns them

Three moves in one PR: every edit is an import line, a deletion, or a re-export, about thirty
files in all, and each move is a self-contained commit so review can go move by move.

- **`dbMsAgo`/`dbMsFromNow` to `@gbd/db`'s root.** New `packages/db/src/clock.ts` holding
  `DB_NOW`, `dbMsAgo`, `dbMsFromNow`, moved from `testing/fixtures/values.ts` (which keeps
  `aChecksum`). `src/index.ts` exports `dbMsAgo` and `dbMsFromNow`; `testing/index.ts` re-exports
  all three from `../clock.ts`, so the testing importers stay as they are. Internal importers
  repointed: `testing/history/insert.ts`, `fixtures/app-user.test.ts`,
  `fixtures/organization.test.ts`. In `apps/worker`, delete `src/sql.ts`; `sweeps/converge.ts`,
  `sweeps/notifications.test.ts` and `testing/attempt-timeline.ts` import `dbMsAgo` from `@gbd/db`.
- **`Breakable`, `withBreakable` and `RUN_STALE_AFTER_MS` to `@gbd/core/testing`.**
  `packages/core/src/testing.ts` gains all three, the constant as `2 * HOUR_MS` with its one doc
  comment ("no live Playwright run lasts this long"). `packages/db/src/testing/breakable.ts`
  imports the type; the `db`, `email` and `storage` testing indexes drop their
  `Breakable`/`withBreakable` exports, and the two re-export lines in
  `email/src/testing/breakable.ts` and `storage/src/testing/breakable.ts` go. Worker importers
  (`attempt/lifecycle.test.ts`, `testing/worker-harness.ts`, `worker.test.ts`) import from
  `@gbd/core/testing`. The four stale-bound sites import the constant and lose their "same bound
  as" comments.
- **`@gbd/db/constraints`, and the three browser mirrors go.** `packages/db/package.json`:
  `"./constraints": "./dist/constraints.js"`, with a header note in `constraints.ts`.
  `apps/web/src/lib/orgs/name.ts`, `lib/account/display-name.ts` and `src/params.ts` import from
  the subpath; delete each mirror, its comment, and the test that pinned it (`name.test.ts`,
  `display-name.test.ts`; `params.test.ts` keeps its test and drops the comment).
  `components/orgs/organization-name-form.svelte` and `components/account/display-name-form.svelte`
  import the constant from the subpath directly.

## PR 2 — One email helper, the export trim, two comments

After PR 1, so the email and storage testing indexes settle once.

- Delete `anEmail` from `apps/web/src/lib/server/testing/email.ts` (keep
  `mockUnreachableEmailer`). `routes/(app)/invites/load-invites.test.ts`,
  `routes/(app)/orgs/organizations-page-redirect.test.ts` and the four inline sites
  (`e2e/fixtures/organizations.ts:127`, `e2e/members/invites.e2e.ts:70`,
  `e2e/members/members.e2e.ts:131`, `routes/api/orgs/[organizationSlug=slug]/invites/
  create-invite.test.ts:169`) use `aTestEmailAddress`, each with a label naming the spec.
- The four index files trimmed per Decisions; `packages/email/README.md:37` names `waitForEmail`.
- `packages/core/src/index.ts:1-4`: `APP_NAME` is the product name shown to users.
  `packages/browser-testing/src/playwright-config.ts`: drop `webServer.cwd` and `env`, and the
  paragraph about running the build from outside the package.
- Deletes this plan, unless PR 3 is taken, in which case that one does.

## PR 3 — Optional: `nodenext` in the base tsconfig

- `tsconfig.base.json`: `module` and `moduleResolution` become `nodenext`, with the override's
  rationale moved there. Delete the block from the eight package tsconfigs. `pnpm check` proves
  `apps/web` is unaffected (`$app/tsconfig` is the later `extends` entry).

## Verification

Each PR: `pnpm lint && pnpm check && pnpm test`, in the background, through Turbo rather than a
package filter, since PR 1 edits packages others consume from `dist/`. No screenshot may change.
For PR 1, `pnpm --filter @gbd/web build` and a search of `apps/web/.svelte-kit/output/client`
for `make_interval` or `pg` finds nothing: the browser bundle gained only `dist/constraints.js`.
