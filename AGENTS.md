# Agent guide

[`README.md`](README.md) is the source of truth for prerequisites, commands, repo layout,
and the testing tiers. Read it first, and prefer it over this file for anything factual —
duplicated facts drift. This file covers how we want code written and the traps that
produce a confusing failure a long way from the cause.

For what the product must do, read [`REQUIREMENTS.md`](REQUIREMENTS.md). For how
the system fits together and why, read [`ARCHITECTURE.md`](ARCHITECTURE.md) — in
particular, both files record *rejected* alternatives, so check them before proposing a
design change.

This repo is TypeScript today and will grow Python workspaces.

## Verifying a change

Run `pnpm lint && pnpm check && pnpm test` from the repo root before saying a change
works. A change that typechecks but has not been run is not verified. Report what you
actually ran; if something is failing or you skipped a step, say so.

## General development principles

- All these principles are not rigid and depend on the context. For example, sometimes DRY
  is appropriate. Other times, WET is appropriate.
- Default to solving in the simplest way possible. It's hard to predict future needs.
  Rather than "premature generalization", simple and maintainable code tends to be the
  easiest to refactor.
- Code is written for humans, not just machines. Maintainability and readability matter.
- Constantly think about how a human can only remember 7 plus or minus 2 things at once
  (chunking). Control the abstraction level, such as using helper functions, whitespace,
  comments, immutability, data structures, etc.

### Functional style

- Generally, prefer functional programming style, but don't be dogmatic about it.
- Default to immutability, which reduces the cognitive load of having to think about what
  may change at any moment.
- Default to functional constructs like `map`, `filter`, and `reduce`. They make it more
  immediately obvious what the iteration will do than an unconstrained `for` loop.
  However, they are not always the best choice.
- Use the type system to make illegal states impossible. For example, use algebraic data
  types, along with string variants like `color: 'red' | 'green'` rather than
  `color: string`.
- OOP can be useful, but generally prefer composition over inheritance and limit
  class-level mutability by default. Classes are often overkill.
- Early returns and "inverting the conditional" are often excellent. Fail early and exit
  the function early so that the main logic is not deeply nested.
- It's often useful to extract pure functions from impure functions. Pure functions are
  much easier to test, and they are easier to reason with.

### Style

- With comments, prefer self-documenting code. However, comments can be very helpful,
  especially to give context that cannot be intuited, such as performance or safety
  considerations, or subtle edge cases.
- Prefer the standard library. When that is not possible, consider using third-party
  libraries, but usually prefer first-party code if it's simple to write because of supply
  chain security being such a pain.

### Testing philosophy

- We deeply value tests to make it easier for us to maintain and extend the app. Whenever
  adding new functionality, you should generally add tests.
- We care about our tests being fast, concurrent, and maintainable. Do not exhaustively
  test things already handled by the standard library and third-party dependencies.

## Documentation

Our worry is not too few docs; it is docs that quietly stop being true. These rules exist to
keep every document either accurate or obviously dead.

- **A doc lives at the highest point in the tree that contains all the code it describes.**
  Something spanning more than one component goes in [`ARCHITECTURE.md`](ARCHITECTURE.md) —
  a colocated doc cannot own a seam between two components. Something about one package
  goes in that package. Product intent, owned by no code, goes in a root doc like
  [`REQUIREMENTS.md`](REQUIREMENTS.md). Once there is more than one such doc, that's the
  signal to introduce a `docs/` folder — not before.
- **But a decision that one file enacts is documented on that file**, in a comment, even when
  its consequences reach other components. Ask which single file someone would have to edit to
  reverse the decision, and put the reasoning there; only split it out when no one file owns
  it. [`ARCHITECTURE.md`](ARCHITECTURE.md) then gets a few lines at most — the consequences
  other components must know, and where the reasoning lives.
- **[`README.md`](README.md) covers what a developer runs, not how the build is wired.**
  Everyone reads it, so keep config and build mechanics out of it unless an everyday command
  actually changed.
- **Say it once, and briefly.** State the rule or the non-obvious constraint and stop. Do not
  walk through the mechanism, the failure it prevented, or what CI does about it — those are
  the sentences that rot first, and length in a doc everyone reads is a cost paid repeatedly.
- **Never restate in prose what the code already states.** No schemas, file trees, or config
  values. Name the file that holds the fact instead. A number copied into a doc is a number
  that will disagree with the code within a month.
- **Prefer documentation that executes.** A schema invariant belongs in a test that asserts
  the database rejects the violation. A cross-language contract belongs in golden fixtures
  that both sides parse. Those cannot rot silently; prose can.
- **Docs carry intent; code carries mechanism.** If a refactor that changes no behaviour
  would force you to edit a doc, that doc is describing mechanism — fix the doc.
- **Record rejected alternatives as one-liners** (`*Rejected: X because Y.*`), wherever the
  decision itself is documented — a code comment counts. But only do this if there's a good
  chance someone will want to relitigate the decision.
- **Mark anything unresolved `**Open:**`** so it is greppable, and leave it where it belongs
  rather than in a separate list of open questions that will drift.
- **One source of truth per fact, named explicitly.** Kysely migrations own the schema; the
  Supabase CLI's `migrations/` is unused. When two files could both plausibly answer a
  question, say in one of them which one wins.
- **A doc written before its code is a spec, and says so** in a status block naming what
  replaces it. [`packages/db/SCHEMA.md`](packages/db/SCHEMA.md) is the current example.

## TypeScript and Svelte

- **Svelte 5 runes only.** Never `export let` or `<slot>`. Most Svelte code in training
  data is Svelte 4, so check the Svelte MCP server rather than recalling an API.
- **Use `async`/`await`**, not raw promise chains.
- **Cross-package imports use the package name** (`@gbd/core`), never a relative path out
  of a package and never a tsconfig path alias.
- **Runtime config comes from `$env/dynamic/private`**, never `$env/static/private`.
- **`@gbd/*` packages are consumed as compiled JS, from `dist/`.** So a package you edit has
  to be rebuilt before another package sees the change; `pnpm dev` runs `tsc --watch` per
  package to keep that automatic, and every other Turbo task depends on `^build`. Each
  package owns its own runtime dependencies — declare them where they are imported, and
  nowhere else.
- **Add a `@gbd/*` package to `apps/web` as a `dependency`, not a `devDependency`,** if
  server code imports it. `apps/web/vite.config.ts` derives the list of packages to leave
  unbundled from `dependencies`, because those are the ones installed next to the built
  server. Getting this wrong silently bundles the package instead of failing.
- **Test file suffixes are load-bearing**: each runner selects files by suffix, so a
  misnamed test is either skipped or picked up by the wrong runner. See the table in the
  README.
- **`vitest-browser-svelte`'s `render` is async.** `const screen = await render(Cmp)`.

## Database

- **`TEST_DB=1` selects the test stack**, everywhere: the Supabase CLI, `migrate` and `truncate`,
  Kanel, and vitest. Without it, you are pointed at the dev database and blob store. The 
  `test:unit` and `test:e2e` scripts set it for you.
- **Always use `scripts/supabase`, never a bare `supabase`.** The wrapper passes `--workdir`; the
  bare CLI finds neither stack and offers to create a third.
- **Write migration columns in snake_case.** `CamelCasePlugin` translates identifiers, so a
  `site_name` column is what makes `siteName` work in queries.
- **`packages/db/src/generated/` is Kanel output**: committed, verified by CI, and deleted
  wholesale on every run. Nothing hand-written goes in it — `src/schema.ts` is its companion.
  Run `pnpm db:gen-types` after every migration and commit the result.
- **Query helpers take `db: DatabaseExecutor` as their first parameter**, so tests can pass a
  rolled-back transaction where the app passes its long-lived handle. For route handlers, put
  the logic in an exported `_`-prefixed function that takes one — SvelteKit permits those
  alongside `GET`/`POST` — and have the handler call it with `database()`. Call `database()`
  inside the handler, never at module scope.
- **Database tests must use `withRollback`** to enable safe concurrency.
- **`pnpm test` is deliberately serial** because `test:e2e` truncates the DB and would break `test:unit`.

## Repo mechanics

- **Dependency versions go in the `catalog:` block of
  [`pnpm-workspace.yaml`](pnpm-workspace.yaml)**, and packages reference them as
  `"catalog:"`. That is what keeps one version across the workspace. The vitest and
  Playwright entries are pinned exactly, not with `^`, because those families declare
  exact peer ranges on each other and `strictPeerDependencies` is on — a range there
  breaks `pnpm install`.
- **`svelte-kit sync` is inlined into the `check` and `test:unit` scripts** because it has
  to run before typechecking or testing. It looks redundant; it isn't. Don't delete it and
  rely on `prepare`, which pnpm runs only for some invocations.
- **Quote parentheses in shell commands.** Route groups mean paths like
  `'src/routes/(app)'` need quoting or the shell mangles them.
- Do not touch CI, adapters, or deployment configuration unless that is the task.
- Do not commit secrets or real customer data.

## PRs and sizing changes

- We squash-merge PRs. So, your PR can have as many commits as you want; it all gets
  combined. That means a PR is the "atomic unit" for changes
- Keep PRs as small and focused as feasible. Smaller PRs are easier for coworkers to
  review, future developers to understand, and better to Git bisect to identify which
  commit changed functionality
- To keep PRs smaller, use "prefactor" PRs when possible (aka stacked PRs). They refactor the code in
  anticipation of the new feature, but don't yet add the new feature.
- It can be helpful to merge code to main even if it isn't yet ready for the end-user to
  consume. Consider techniques like feature gates. However, the code should be in a good
  state before being merged.

## Svelte MCP server

You have access to the Svelte MCP server, which carries the full Svelte 5 and SvelteKit
documentation. Use it rather than recalling API details.

- **`list-sections`** — call this first to discover what documentation exists. Read the
  `use_cases` field to decide what is relevant.
- **`get-documentation`** — fetch every section the task touches, not just one.
- **`svelte-autofixer`** — run this on any Svelte code you write before showing it.
  Keep calling it until it returns no issues.
