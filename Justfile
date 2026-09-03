# Python only. TypeScript has pnpm and Turbo — see README.md.
#
# Recipe names mirror the pnpm scripts in `package.json` so the two stacks feel the same, and
# CI runs these recipes rather than its own copy of the commands.

# List the recipes.
default:
    @just --list --unsorted

# Install every workspace member and the dev tools into .venv.
sync:
    uv sync --all-packages

# Lint, and check formatting.
lint:
    uv run ruff check .
    uv run ruff format --check .

# Format, and apply every fix ruff can make.
fmt:
    uv run ruff format .
    uv run ruff check --fix .

# Typecheck.
check:
    uv run ty check python scripts

# Test everything we ship.
test:
    uv run pytest -n auto python/insights python/worker_child

# Test the lab, which ships nothing.
test-lab:
    uv run pytest -n auto python/lab
