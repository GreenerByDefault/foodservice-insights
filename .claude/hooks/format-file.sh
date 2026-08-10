#!/usr/bin/env bash
# Formats the file Claude just edited, so formatting never shows up in review.
#
# Always exits 0. A formatter that fails or is not installed is not something Claude should stop
# and fix mid-edit — `pnpm lint` and `just lint` are what gate a change.

set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

file=$(jq -r '.tool_input.file_path // empty')
[[ -n $file && -f $file ]] || exit 0

# Relative, so the skip patterns below don't depend on where the repo is checked out.
file=${file#"$PWD/"}

# Files outside the repo (edited via an absolute or ../ path) have nothing here to format.
case $file in
  /* | ../*) exit 0 ;;
esac

# Direct binaries, not `pnpm exec`/`uv run` — those wrappers re-resolve the workspace/venv on
# every call, which dominates runtime on a hook that fires on every single edit.
case $file in
  *.ts | *.js | *.svelte | *.json | *.css)
    "$PWD/node_modules/.bin/biome" check --write --no-errors-on-unmatched "$file"
    ;;
  *.py)
    "$PWD/.venv/bin/ruff" format "$file"
    ;;
esac

exit 0
