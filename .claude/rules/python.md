---
paths:
  - "python/**"
  - "scripts/**/*.py"
  - "contract/**"
  - "pyproject.toml"
  - "uv.lock"
  - "Justfile"
  - ".python-version"
---

# Python

The universal rules in [`AGENTS.md`](../../AGENTS.md) apply here too — development
principles, the documentation rules, PR sizing. This file is only what is specific to
Python; nothing on the TypeScript side applies, since the two stacks share no toolchain.
[`python/README.md`](../../python/README.md) covers what to run.

Verify a change with `just lint && just check && just test`, plus `just test-lab` if you
touched the lab.

## The workspace

- **One virtual environment and one lockfile, both at the repo root.** Every package resolves
  against the same versions; there is no per-package venv to activate.
- **Runtime dependencies go in the package that imports them**, never the root
  `pyproject.toml`, which holds only the dev tools. Same rule as the `@gbd/*` packages.
- **Never add a `[tool.ruff]` section to a package's `pyproject.toml`.** Ruff binds each file
  to the *closest* `pyproject.toml` that has one, so a local section silently replaces the
  root config — including the lab ban — rather than extending it.
- **Packaged assets live inside `<package>/`.** Hatchling ships every non-Python file
  under the package directory and nothing outside it. Read them with a plain path from
  `PACKAGE_DIR` in the package's `__init__.py`: the package is always installed as files on
  disk (the worker image installs `--no-editable` into site-packages), never zipped.
  *Rejected: `importlib.resources`, which only pays off for zipped installs.*

## The lab boundary

`gbd_foodservice_insights_lab` is where data scientists experiment without the product's
constraints, so its code carries none of the product's guarantees.

- **Nothing we ship may import it.** Ruff enforces this; the root `pyproject.toml` holds the
  rule and the reasoning.
- **The lab may import whatever it likes**, including `gbd_foodservice_insights`. The dependency
  runs one way only.
- Put code in the lab when it is exploratory, and move it into `gbd_foodservice_insights` when
  the worker needs it — not the other way around.
- **Before optimizing or fixing ported code, check that the product needs it.** Trace whether
  `analyze()` reaches it and whether its output reaches a customer. The product only ever sees
  validated CSVs from `apps/web`, so much ported code is lab-only in practice, and moving it to
  the lab is often simpler than making it fast.
- **"No caller in the repo" does not prove code is dead.** Data scientists call product and lab
  code from notebooks in the gitignored `client_work/`, which no grep can see. Breaking changes
  are accepted, so delete what is superseded or a one-liner over something that stays, but keep
  or move to the lab what is real capability (regions, modes, taxonomy getters). Name those
  judgment calls in the PR description.

## LLM providers

- **Categorization runs on OpenAI, behind `LlmClient`** in `categorization/llm.py`. Pipeline
  code takes an `LlmClient`, never a provider SDK client; `OpenAiLlmClient` is where a provider
  swap happens.
- **GBD prefers Gemini for new LLM work**, but only the lab calls it — entree detection and
  extraction. Ruff bans `google.genai` from product code.
- **Tests use `testing.KeywordLlmClient`**, never the network.

## Style

- **Tests live in `<package>/tests/`, not beside the code.**
- **ty is the typechecker**. Annotate new code even though the ported
  library largely is not annotated yet; where a ported module is too noisy to fix now, add a
  scoped `[[tool.ty.overrides]]` entry or inline ignore comment rather than loosening the global rules.
- **Prefer `pathlib` over `os.path`**, and pass paths as `Path`.
- **Fail loudly on bad data.** No silent skipping and no deferred error collection: rejecting a
  report beats delivering a misleading one.
- **Every pipeline step asserts its row counts and logs its before/after shape.** A step that
  silently drops or overwrites rows is the failure we fear most.
- **Plain pandas is fine, but nothing per row or per pair of products in Python.** An upload
  can reach `MAX_DATA_ROWS` (`apps/web/src/lib/reports/limits.ts`) and tens of thousands of
  distinct products. Short of that, do not optimize without a measurement.
