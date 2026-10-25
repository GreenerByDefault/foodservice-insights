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
| TypeScript — `apps/`, `packages/`, `tests/` | [`.claude/rules/typescript.md`](.claude/rules/typescript.md) | [`docs/typescript.md`](docs/typescript.md) |
| Python — `python/` | [`.claude/rules/python.md`](.claude/rules/python.md) | [`python/README.md`](python/README.md) |

If you are about to change one of those stacks and its rule file has not appeared in your
context, read it first. Narrower rules load on top for the web app, the database package and the
worker contract; each rule file's `paths` list is the truth for where it applies.

Writing or changing a doc is covered by the `writing-docs` skill — where a doc belongs, how long
it should be, and what must never go in one.

For what the product must do, read [`docs/requirements.md`](docs/requirements.md). For how the system
fits together and why, read [`docs/architecture.md`](docs/architecture.md) — both record *rejected*
alternatives, so check them before proposing a design change.

## Claude Code plans

`.claude/plans/` holds a plan per multi-step feature currently in flight — the design, the
decisions behind it, and the PRs it breaks into. Each is named for its feature, so `ls` the
directory before starting a change and read one only when its name covers what you were asked
to do.

A plan is where the work was headed, not a spec. Where the code has since moved on, the code
wins — say so rather than following the plan into a design it already abandoned.

Plans are deleted, not archived. `/plan-advance` folds each landed PR back into its plan, and
the PR that lands the last one removes the file, so a plan here is always unfinished work.
`/plan-adopt` brings a plan mode plan in from `~/.claude/plans`, using a name that will route correctly.

## Verifying a change

Run the checks for the stack you changed, from the repo root, before saying a change works:

| Stack | Command |
| --- | --- |
| TypeScript | `pnpm lint && pnpm check && pnpm test` |
| Python | `just lint && just check && just test` |

A change that typechecks but has not been run is not verified. Report what you actually ran;
if something is failing or you skipped a step, say so. A test that fails and then passes
unchanged is a flake: name it in your report, but don't stop to fix it unless asked.

Run Playwright's `--repeat-each` with `--workers=1` to avoid copies of one test colliding in the database.

## General development principles

Context beats dogma: sometimes DRY is right, sometimes WET. Beyond that, the defaults we want
differ from an agent's defaults:

- **Solve it the simplest way.** Future needs are hard to predict; simple code is the easiest
  to refactor, so no premature generalization.
- **Keep the abstraction level a reader can hold**, about seven things at once: helper
  functions, whitespace, data structures.
- **Immutable by default**, and `map`/`filter`/`reduce` over an unconstrained `for` loop when
  they read better.
- **Make illegal states unrepresentable**: algebraic data types and `color: 'red' | 'green'`,
  not `color: string`.
- **Composition over inheritance; classes are often overkill**, and keep class-level state
  minimal.
- **Early returns**, so the main logic is not nested. **Extract pure functions** from impure
  ones; they are what tests reach easily.

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
- **Cite a doc as the source of a fact, not as a substitute for one.** Write `path.md § Heading`
  with the heading in full, so `scripts/ci/check_doc_links.py` can tell when it breaks.
- **Do not restate the test name above the test**, and skip prose that only reassures the
  reader.

### Style

- Prefer the standard library. When that is not possible, consider using third-party
  libraries, but usually prefer first-party code if it's simple to write because of supply
  chain security being such a pain.
- Don't bind a local that only renames something already named, like
  `products = categorized.unique_products_df`; inline the access instead. A local that names a
  computed value, or adds meaning, is fine. Tests get more slack for arrange-step locals.

### Testing philosophy

- We deeply value tests to make it easier for us to maintain and extend the app. Whenever
  adding new functionality, you should generally add tests.
- We care about our tests being fast, concurrent, and maintainable. When proposing something
  that adds test time, estimate wall clock as per-unit cost × count ÷ workers, give local and CI
  separately (CI has fewer cores).
- Don't re-test something that already carries its own guarantee — the standard library, a
  third-party dependency, or a first-party leaf module with its own exhaustive tests. Trust that contract and put the test at the integration point instead:
  does *this* code call it correctly, handle the edges it exposes, and compose it with the rest
  of the pipeline — not every case the leaf already covers.
- Prefer `toEqual` over `toMatchObject` (or an equivalent partial-match assertion): a full
  equality check catches an unexpected field a partial match would silently let through. Fall
  back to a partial match when the full value is noisy or irrelevant to what the test is
  checking — e.g. a timestamp or generated id — not as a default.
- Cover the edge cases the source code actually branches on — empty/null/boundary inputs, error
  paths — not just the happy path.

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
- Do not change the guardrails in `.claude/settings.json` unless that is the task.
- Do not commit secrets or real customer data.
