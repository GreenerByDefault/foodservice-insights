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
context, read it first.

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
- **A README covers what a developer runs, not how the build is wired.** Everyone reads it,
  so keep config and build mechanics out of it unless an everyday command actually changed.
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
- **One source of truth per fact, named explicitly.** When two files could both plausibly answer a
  question, say in one of them which one wins.
- **A doc written before its code is a spec, and says so** in a status block naming what replaces it.

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
