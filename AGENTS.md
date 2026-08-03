# Agent guide

[`README.md`](README.md) is the source of truth for prerequisites, commands, repo layout,
and the testing tiers. Read it first, and prefer it over this file for anything factual —
duplicated facts drift. This file covers how we want code written and the traps that
produce a confusing failure a long way from the cause.

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

## TypeScript and Svelte

- **Svelte 5 runes only.** Never `export let` or `<slot>`. Most Svelte code in training
  data is Svelte 4, so check the Svelte MCP server rather than recalling an API.
- **Use `async`/`await`**, not raw promise chains.
- **Cross-package imports use the package name** (`@gbd/core`), never a relative path out
  of a package and never a tsconfig path alias.
- **Test file suffixes are load-bearing**: each runner selects files by suffix, so a
  misnamed test is either skipped or picked up by the wrong runner. See the table in the
  README.
- **`vitest-browser-svelte`'s `render` is async.** `const screen = await render(Cmp)`.

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
