# Agent guide

How we want code written here, and the traps that produce a confusing failure a long way from
the cause. Everything in this file applies to both stacks.

**The code is the source of truth.** Commands are defined in [`package.json`](package.json)
and the [`Justfile`](Justfile); the layout is the filesystem; limits and schemas live in the
files that enforce them. The READMEs orient someone getting started and can lag behind — when
a README disagrees with the code, the code wins and the README is a bug to fix.

Two stacks live here, and they share no toolchain. The rules for each are path-scoped, so
they load when you touch that stack's files:

| Working on | Rules | Getting started |
| --- | --- | --- |
| TypeScript — `apps/`, `packages/` | [`.claude/rules/typescript.md`](.claude/rules/typescript.md) | [`README.md`](README.md) |
| Python — `python/` | [`.claude/rules/python.md`](.claude/rules/python.md) | [`python/README.md`](python/README.md) |

If you are about to change one of those stacks and its rule file has not appeared in your
context, read it first. Writing or changing a doc is covered by the `writing-docs` skill —
where a doc belongs, how long it should be, and what must never go in one.

For what the product must do, read [`REQUIREMENTS.md`](REQUIREMENTS.md). For how the system
fits together and why, read [`ARCHITECTURE.md`](ARCHITECTURE.md) — both record *rejected*
alternatives, so check them before proposing a design change.

## Verifying a change

Run the checks for the stack you changed, from the repo root, before saying a change works:

| Stack | Command |
| --- | --- |
| TypeScript | `pnpm lint && pnpm check && pnpm test` |
| Python | `just lint && just check && just test` |

A change that typechecks but has not been run is not verified. Report what you actually ran;
if something is failing or you skipped a step, say so.

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

### Comments

Prefer self-documenting code: a good name beats a comment explaining a bad one. What survives
that is worth a great deal, because it is what the code cannot say — a performance
consideration, a security invariant, a subtle edge case, a constraint arriving from outside the
file. Write those, and give them the room they need.
[`packages/storage/src/keys.ts`](packages/storage/src/keys.ts) opens with 21 lines and earns
every one; a diagram or a numbered list of invariants is a fine way to spend them.

The test is whether a reader could recover the fact from the code, the types, or the test name.
If not, write it. If so, the comment is a second copy of something that will drift.

- **Put it on the thing it explains** — the line, or the file header when it holds across the
  file. Not in a doc comment one level up.
- **Do not narrate the design of a function whose signature already shows it.** The shape to
  avoid is a summary line, a blank `*`, then a paragraph of rationale. Keep the summary; drop
  the paragraph.
- **Cite a doc as the source of a fact, not as a substitute for one.**
- **Do not restate the test name above the test**, and skip prose that only reassures the
  reader.

### Style

- Prefer the standard library. When that is not possible, consider using third-party
  libraries, but usually prefer first-party code if it's simple to write because of supply
  chain security being such a pain.

### Testing philosophy

- We deeply value tests to make it easier for us to maintain and extend the app. Whenever
  adding new functionality, you should generally add tests.
- We care about our tests being fast, concurrent, and maintainable. Do not exhaustively
  test things already handled by the standard library and third-party dependencies.

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

## Off limits

- Do not touch CI, adapters, or deployment configuration unless that is the task.
- Do not commit secrets or real customer data.
