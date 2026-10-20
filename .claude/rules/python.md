---
paths:
  - "python/**"
  - "scripts/**/*.py"
  - "pyproject.toml"
  - "uv.lock"
  - "Justfile"
  - ".python-version"
---

# Python

What is specific to the Python stack, on top of [`AGENTS.md`](../../AGENTS.md); nothing on the
TypeScript side applies. [`python/README.md`](../../python/README.md) covers what to run and where
things go.

Verify a change with `just lint && just check && just test`, plus `TEST_DB=1 just test-lab` if you
touched the lab; without `TEST_DB=1`, the lab's database tests skip.

- **Never add a `[tool.ruff]` section to a package's `pyproject.toml`.** The root one says why.
- **Read packaged assets from `PACKAGE_DIR`**, and keep them inside the package directory.
- **ty is the typechecker. Annotate new code.**
- **Fail loudly on bad data.** No silent skipping and no deferred error collection: rejecting a
  report beats delivering a misleading one.
- **Every pipeline step asserts its row counts and logs its before/after shape.** A step that
  silently drops or overwrites rows is the failure we fear most.
- **Plain pandas is fine, but nothing per row or per pair of products in Python.** An upload can
  reach `MAX_DATA_ROWS` (`apps/web/src/lib/reports/limits.ts`) and tens of thousands of distinct
  products. Short of that, do not optimize without a measurement.
- **Pipeline code takes an `LlmClient`** (`categorization/llm.py`), never a provider's SDK client.
  Tests use `testing.KeywordLlmClient`, never the network.

## The lab boundary

`gbd_foodservice_insights_lab` is where data scientists experiment without the product's
constraints. Nothing we ship may import it, which Ruff enforces; the lab may import anything,
the product included.

- **Code starts in the lab while it is exploratory**, and moves into `gbd_foodservice_insights`
  when the worker needs it.
- **Before optimizing or fixing ported code, check that the product needs it.** Trace whether
  `analyze()` reaches it and whether its output reaches a customer. The product only ever sees
  validated CSVs from `apps/web`, so much ported code is lab-only in practice, and moving it to the
  lab is often simpler than making it fast.
- **"No caller in the repo" does not prove code is dead.** Data scientists call product and lab
  code from notebooks in the gitignored `client_work/`, which no grep can see. Breaking changes
  are accepted, so delete what is superseded or a one-liner over something that stays, but keep
  or move to the lab what is real capability (regions, modes, taxonomy getters). Name those
  judgment calls in the PR description.
