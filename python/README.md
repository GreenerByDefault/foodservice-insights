# Python

The AI analysis library, the worker's child process, and the data-science lab. This file is
the Python counterpart to the root [`README.md`](../README.md). Go there for the repo layout, the
documentation index, and what CI runs. [`.claude/rules/python.md`](../.claude/rules/python.md) has how we write Python.

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

### Install

```sh
just sync
```

## Everyday commands

Run these from anywhere in the repo.

| Command | What it does |
| --- | --- |
| `just` | List every recipe |
| `just sync` | Install every package and dev tool into `.venv` |
| `just lint` | Ruff: lint rules, import sorting, and a formatting check |
| `just fmt` | Ruff, applying fixes |
| `just check` | ty: typechecking |
| `just test` | Tests for the two packages we ship |
| `just test-lab` | Tests for the lab |

For anything one-off, prefix it with `uv run`: `uv run python`, `uv run pytest -k categorize -x`.

## Testing

Tests live in `<package>/tests/` and are named `test_*.py`. They run concurrently under
`pytest-xdist`; a bare `uv run pytest` is serial, which is what you want while debugging a
single failure.

Mark a test `@pytest.mark.slow` or `@pytest.mark.llm` if it's expensive or calls a real LLM.

## Occasional tasks

### Add a dependency

Add it to `[project.dependencies]` of the package that imports it, then `just sync`.

### API keys

The analysis library will want `GEMINI_API_KEY`, `OPENAI_API_KEY`, and
`LLM_WHISPERER_API_KEY`. They are deliberately absent from
[`../.env.example`](../.env.example) until the code that reads them lands.
