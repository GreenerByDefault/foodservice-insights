# Python

The AI analysis library, the worker's child process, and the data-science lab. This file is
the Python counterpart to the root [`README.md`](../README.md), whose TypeScript half you
should not need — the two stacks share no toolchain. Go there for the repo layout, the
documentation index, and what CI runs.
[`.claude/rules/python.md`](../.claude/rules/python.md) has how we write Python here.

## Getting started

### Prerequisites

- **[uv](https://docs.astral.sh/uv/)** — the environment, the lockfile, and the interpreter:

  ```sh
  brew install uv
  ```

- **[just](https://just.systems)** — the command runner:

  ```sh
  brew install just
  ```

You do not need to install Python yourself. uv reads
[`../.python-version`](../.python-version) and fetches that interpreter.

### Install

```sh
just sync
```

That creates `.venv/` at the repo root and installs all three packages into it, editable — so
an edit takes effect immediately, with no rebuild and no re-sync.

## Everyday commands

Run these from anywhere in the repo; `just` searches upward for the
[`Justfile`](../Justfile). Each recipe is exactly what CI runs.

| Command | What it does |
| --- | --- |
| `just` | List every recipe |
| `just sync` | Install every package and dev tool into `.venv` |
| `just lint` | Ruff: lint rules, import sorting, and a formatting check |
| `just fmt` | Ruff, applying fixes |
| `just check` | ty: typechecking |
| `just test` | Tests for the two packages we ship |
| `just test-lab` | Tests for the lab |

There is no build or dev recipe. Python packages are consumed from source, so nothing has to
be compiled before another package sees a change — the opposite of the `@gbd/*` packages on
the TypeScript side.

For anything one-off, prefix it with `uv run`: `uv run python`, `uv run pytest -k categorize -x`.

## Testing

Tests live in `<package>/tests/` and are named `test_*.py`. They run concurrently under
`pytest-xdist`; a bare `uv run pytest` is serial, which is what you want while debugging a
single failure.

`just test` and `just test-lab` are separate because CI gates them on different filters:
nothing depends on the lab, so lab breakage must never block a change to the product.

Two markers are declared in the root [`pyproject.toml`](../pyproject.toml), `slow` and `llm`.
`--strict-markers` is on, so a typo'd marker is an error rather than a test that silently
never runs.

## Occasional tasks

### Add a dependency

Add it to `[project.dependencies]` of the package that imports it — never the root, which
holds only the dev tools — then `just sync`. One lockfile covers the workspace, so every
package resolves to the same version.

### Add a package

Create `python/<name>/` with a `pyproject.toml` and `src/<name>/`. The root
`pyproject.toml`'s workspace globs `python/*`, so nothing else needs editing — but check
whether [`../.github/filters.yml`](../.github/filters.yml) and the
[`Justfile`](../Justfile) need to know about it.

### API keys

The analysis library will want `GEMINI_API_KEY`, `OPENAI_API_KEY`, and
`LLM_WHISPERER_API_KEY`. They are deliberately absent from
[`../.env.example`](../.env.example) until the code that reads them lands.
