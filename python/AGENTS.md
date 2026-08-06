# Python agent guide

[`README.md`](README.md) is the source of truth for prerequisites, commands, and testing —
read it first, and prefer it over this file for anything factual. The root
[`AGENTS.md`](../AGENTS.md) carries everything that applies to both stacks: development
principles, the documentation rules, PR sizing. **Those apply here too.** This file covers
only what is specific to Python.

> **Status:** the packages are scaffolding. The analysis library moves in from the
> `catering_analysis` repo in a later change, and the conventions its authors already follow
> merge into this file then — see [Open](#open).

## Verifying a change

`just lint && just check && just test` from the repo root, plus `just test-lab` if you
touched the lab.

## The workspace

- **One virtual environment and one lockfile, both at the repo root.** Every package resolves
  against the same versions; there is no per-package venv to activate.
- **Runtime dependencies go in the package that imports them**, never the root
  `pyproject.toml`, which holds only the dev tools. Same rule as the `@gbd/*` packages.
- **Never add a `[tool.ruff]` section to a package's `pyproject.toml`.** Ruff binds each file
  to the *closest* `pyproject.toml` that has one, so a local section silently replaces the
  root config — including the lab ban — rather than extending it.
- **Packaged assets live inside `src/<package>/`.** Hatchling ships every non-Python file
  under the package directory and nothing outside it, so a data file placed beside `src/`
  is missing at runtime rather than failing the build.

## The lab boundary

`foodservice_insights_lab` is where data scientists experiment without the product's
constraints, so its code carries none of the product's guarantees.

- **Nothing we ship may import it.** Ruff enforces this; the root `pyproject.toml` holds the
  rule and the reasoning.
- **The lab may import whatever it likes**, including `foodservice_insights`. The dependency
  runs one way only.
- Put code in the lab when it is exploratory, and move it into `foodservice_insights` when
  the worker needs it — not the other way around.

## Style

- **Tests live in `<package>/tests/`, not beside the code.** This differs from the TypeScript
  side, which colocates.
- **ty is the typechecker**, not mypy or pyright. Annotate new code even though the ported
  library largely is not annotated yet; where a ported module is too noisy to fix now, add a
  scoped `[[tool.ty.overrides]]` entry rather than loosening the global rules.
- **Prefer `pathlib` over `os.path`**, and pass paths as `Path`.
- Everything else the root [`AGENTS.md`](../AGENTS.md) says about functional style,
  immutability, early returns, and making illegal states unrepresentable applies here.

## Open

**Open:** the analysis library's own conventions have not been merged in yet. When its code
lands, fold in `catering_analysis`'s `AGENTS.md` §9 (fail loudly on bad data with no silent
skipping, row-count assertions and before/after shape logging on every pipeline step, avoid
OOP, CSV for intermediate files, and the client/period/step filename convention) and §10
(domain knowledge: the common shapes of broken client data, `GBD_categories.yaml` as the
single source of truth for emissions factors, and the Gemini-first LLM provider preference).
Decide at that point which of those belong here versus in a comment on the file that enacts
them.

**Open:** packaged data files are read today with `Path(__file__).parent`, which assumes the
package is on disk rather than zipped. Decide whether to move to `importlib.resources` during
the port or to commit to always installing from source.
