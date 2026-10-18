# Test fixtures: web's server test helpers

## Context

The shared row fixtures live in `packages/db/src/testing/fixtures/`, one file per aggregate's
root table, each with its `.test.ts` beside it. By the rule at the top of `fixtures/index.ts`,
every fixture creates any parent it was not given and any child the schema requires at `COMMIT`,
so its default output commits as-is: `insertReport` adds the report's input file, and
`insertAnalysisAttempt({ status: 'succeeded' })` adds a pdf and an xlsx. A caller that needs to
build that child itself passes `inputFile: null` or `resultFiles: null`. The e2e and worker
fixtures that commit for real build on these defaults rather than adding children by hand.

What is left is tidying the web app's own server test helpers, which predate the naming rule in
`.claude/rules/typescript.md` § Database (`insert*` writes rows, `a*`/`an*` builds a value in
memory, `with*` scopes a committed fixture).

## PR 1 (small, optional): web's server test helpers

In `apps/web/src/lib/server/testing/fixtures.ts`, `anOrganizationCreator`,
`anOrganizationWithMembers` and `anAdminOrg` write rows, so under the naming rule they become
`insert*`. That is 8 files, mechanical. The file also mixes in-memory auth builders, database
composites and an email `vi.mock` factory. Split it into `testing/auth.ts`,
`testing/organizations.ts` and `testing/email.ts`.

## Not doing

- **A factory library** (fishery or similar). AGENTS.md prefers first-party code where it is
  simple, and these are plain functions.
- **Moving the route-level in-memory builders** (`aMember`, `aReport`, `anInviteOffer`). They sit
  next to the view model they build, which is the right place.
- **Making `withRollback` call `checkDeferredConstraints` before it rolls back.** It would
  enforce committability everywhere, but constraint tests deliberately build states that cannot
  commit and would need a way to opt out. Now that the defaults commit, it is worth
  reconsidering on its own merits, separately from this plan.
- **Python fixtures and `contract/fixtures/`.** They are out of scope, and not where the growth
  is.

## Verification

Run `pnpm lint && pnpm check && pnpm test` from the root. The rename is mechanical, so
typechecking finds every caller.
