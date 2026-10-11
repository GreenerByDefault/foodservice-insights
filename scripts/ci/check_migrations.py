#!/usr/bin/env python3
"""Check a branch's migrations for failures that only the hosted database would show.

CI migrates a fresh database, which accepts things the hosted one, with every earlier migration
already applied, refuses or survives badly:

1. A new migration must sort after every migration on the base branch. Kysely runs with
   `allowUnorderedMigrations: false`, so one that sorts before an applied migration is refused
   at deploy, and every later deploy fails at the same step until someone renames it.
2. A migration on the base branch must not be deleted or renamed: Kysely refuses to run once an
   applied migration goes missing. Editing one is only a warning, since a comment fix is
   harmless, but a schema edit never reaches a database that already applied it.
3. A new migration must stay backwards-compatible with the worker and web already deployed,
   which keep running against the new schema (`ARCHITECTURE.md` § Worker deploys only on demand).
   A line that looks incompatible fails unless it, or the comment directly above it, says why
   the deployed services survive it: `// backwards-compatible-because: <why>`.

Check 3 is a grep, not a parser. It catches the common shapes and can be fooled; the marker is
what makes a reviewer look. Check 1 is only as fresh as the base branch, so Kysely's own refusal
at deploy remains the backstop.

Compares the working tree, untracked files included, against the merge base with
`$TURBO_SCM_BASE` (default `origin/main`).
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from itertools import takewhile
from pathlib import Path, PurePosixPath
from typing import Final, Literal

REPO_ROOT: Final = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR: Final = "packages/db/migrations"
DEFAULT_BASE: Final = "origin/main"

# Kysely's FileMigrationProvider loads every `.ts` file in the folder and keeps those that export
# `up`, so `_shared.ts` is skipped only because it has no `up`. Here the underscore marks a
# helper instead, which matters: `_` sorts after every digit, so a helper counted as a migration
# would make every new one look out of order.
_MIGRATION_NAME: Final = re.compile(r"^\d{3}_[a-z0-9]+(?:_[a-z0-9]+)*\.ts$")
_MARKER: Final = re.compile(r"//\s*backwards-compatible-because:\s*\S")

# Each pattern names what it found. Builder calls are matched by name; raw SQL by keyword, any
# case, so that `dropTable` does not also count as `DROP`.
_INCOMPATIBLE_LINES: Final = (
    (re.compile(r"\.(drop(?!NotNull)[A-Z]\w*)\("), None),
    (re.compile(r"\.(rename\w*)\("), None),
    (re.compile(r"\.(setNotNull|setDataType)\("), None),
    # Relaxing NOT NULL is the usual first step of retiring a column, and safe for older code.
    (re.compile(r"\bDROP\b(?!\s+NOT\s+NULL)", re.IGNORECASE), "DROP"),
    (re.compile(r"\bRENAME\b", re.IGNORECASE), "RENAME"),
    (re.compile(r"\bSET\s+NOT\s+NULL\b", re.IGNORECASE), "SET NOT NULL"),
    (
        re.compile(r"\bALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE\b", re.IGNORECASE),
        "ALTER … TYPE",
    ),
    (
        re.compile(r"\bADD\s+COLUMN\b(?!.*\bDEFAULT\b).*\bNOT\s+NULL\b", re.IGNORECASE),
        "ADD COLUMN … NOT NULL without DEFAULT",
    ),
)
_ADD_COLUMN: Final = re.compile(r"\.addColumn\(")
# A line comment, but not the `//` inside a URL.
_LINE_COMMENT: Final = re.compile(r"(?:^|(?<=\s))//.*$")

Severity = Literal["error", "warning"]
OutputStyle = Literal["plain", "github"]


@dataclass(frozen=True)
class Problem:
    path: str
    line: int | None
    message: str
    severity: Severity = "error"


@dataclass(frozen=True)
class Changes:
    """How the branch changed the migrations folder, as repo-relative paths."""

    added: tuple[str, ...]
    modified: tuple[str, ...]
    removed: tuple[str, ...]


def is_migration(path: str) -> bool:
    name = PurePosixPath(path).name
    return name.endswith(".ts") and not name.startswith("_")


def stem(path: str) -> str:
    """The name Kysely records for a migration: its file name up to the last dot."""
    name = PurePosixPath(path).name
    return name[: name.rindex(".")]


def parse_name_status(output: str) -> Changes:
    """Parse `git diff --name-status -z -M`, where a rename carries both its paths."""
    fields = iter(output.split("\0"))
    added: list[str] = []
    modified: list[str] = []
    removed: list[str] = []
    for status in fields:
        if not status:
            continue
        match status[0]:
            case "A":
                added.append(next(fields))
            case "R":
                removed.append(next(fields))
                added.append(next(fields))
            case "D":
                removed.append(next(fields))
            case _:
                modified.append(next(fields))
    return Changes(tuple(added), tuple(modified), tuple(removed))


def naming_problems(added: Iterable[str]) -> list[Problem]:
    return [
        Problem(
            path,
            None,
            "is not named like a migration (`NNN_snake_case.ts`), so it would sort out of order "
            "against every numbered one. A shared helper's name starts with `_`.",
        )
        for path in added
        if is_migration(path) and not _MIGRATION_NAME.match(PurePosixPath(path).name)
    ]


def ordering_problems(added: Iterable[str], base: Iterable[str]) -> list[Problem]:
    """Kysely compares stems with JavaScript's default sort, which matches Python's for ASCII."""
    applied = [stem(path) for path in base if is_migration(path)]
    if not applied:
        return []
    latest = max(applied)
    return [
        Problem(
            path,
            None,
            f"sorts before `{latest}`, which the base branch already has, so the hosted "
            "database will refuse it. Renumber it to sort last.",
        )
        for path in added
        if is_migration(path) and stem(path) <= latest
    ]


def history_problems(changes: Changes, base: Iterable[str]) -> list[Problem]:
    applied = {path for path in base if is_migration(path)}
    removed = [
        Problem(
            path,
            None,
            "is on the base branch, so the hosted database may already have applied it, and "
            "Kysely refuses to run once an applied migration is missing. Restore it.",
        )
        for path in changes.removed
        if path in applied
    ]
    edited = [
        Problem(
            path,
            None,
            "is on the base branch. A database that already applied it will not see this edit; "
            "a schema change needs a new migration.",
            severity="warning",
        )
        for path in changes.modified
        if path in applied
    ]
    return removed + edited


def code_lines(text: str) -> list[str]:
    """`text`'s lines with comments blanked, so that prose cannot match a pattern."""

    def strip(line: str) -> str:
        if line.lstrip().startswith(("*", "/*")):
            return ""
        return _LINE_COMMENT.sub("", line)

    return [strip(line) for line in text.splitlines()]


def _add_column_without_default(lines: Sequence[str]) -> list[tuple[int, str]]:
    """`addColumn(…)` calls that are `notNull()` with no `defaultTo(…)`, by 1-based line.

    An older writer omits the column, so its INSERT fails. The call can span lines, so match its
    parentheses (ignoring any inside strings, which migrations rarely have).
    """
    text = "\n".join(lines)
    found: list[tuple[int, str]] = []
    for match in _ADD_COLUMN.finditer(text):
        depth, end = 1, match.end()
        while depth and end < len(text):
            depth += {"(": 1, ")": -1}.get(text[end], 0)
            end += 1
        call = text[match.start() : end]
        if ".notNull()" in call and ".defaultTo(" not in call:
            line = text.count("\n", 0, match.start()) + 1
            found.append((line, "addColumn … notNull() without defaultTo"))
    return found


def incompatible_changes(text: str) -> list[tuple[int, str]]:
    """Lines that look backwards-incompatible, as (1-based line, what matched)."""
    lines = code_lines(text)
    by_line = [
        (number, label or match[1])
        for number, line in enumerate(lines, start=1)
        for pattern, label in _INCOMPATIBLE_LINES
        if (match := pattern.search(line))
    ]
    return sorted({*by_line, *_add_column_without_default(lines)})


def compatibility_problems(path: str, text: str) -> list[Problem]:
    raw = text.splitlines()

    def marked(line: int) -> bool:
        # The whole run of `//` lines directly above, since line limits wrap a reason.
        comment = takewhile(
            lambda above: above.lstrip().startswith("//"), reversed(raw[: line - 1])
        )
        return any(_MARKER.search(candidate) for candidate in (raw[line - 1], *comment))

    return [
        Problem(
            path,
            line,
            f"`{found}` can break the worker and web already deployed, which keep running "
            "against this schema. Add the new shape now and remove the old one in a later "
            "migration, or say on this line or in the comment above why they survive it: "
            "`// backwards-compatible-because: <why>`.",
        )
        for line, found in incompatible_changes(text)
        if not marked(line)
    ]


def _git(*args: str, repo: Path) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=True
    ).stdout


def find_problems(repo: Path, base: str) -> list[Problem]:
    base_files = _git("ls-tree", "-r", "--name-only", base, "--", f"{MIGRATIONS_DIR}/", repo=repo)
    diff = _git(
        "diff", "--name-status", "-z", "-M", "--merge-base", base, "--", MIGRATIONS_DIR, repo=repo
    )
    untracked = _git("ls-files", "-z", "--others", "--exclude-standard", MIGRATIONS_DIR, repo=repo)

    on_base = base_files.splitlines()
    tracked = parse_name_status(diff)
    changes = Changes(
        added=(*tracked.added, *filter(None, untracked.split("\0"))),
        modified=tracked.modified,
        removed=tracked.removed,
    )
    new_migrations = [path for path in changes.added if is_migration(path)]
    return [
        *naming_problems(changes.added),
        *ordering_problems(new_migrations, on_base),
        *history_problems(changes, on_base),
        *(
            problem
            for path in new_migrations
            for problem in compatibility_problems(path, (repo / path).read_text(encoding="utf-8"))
        ),
    ]


def format_problem(problem: Problem, style: OutputStyle) -> str:
    if style == "github":
        location = f"file={problem.path}" + (f",line={problem.line}" if problem.line else "")
        return f"::{problem.severity} {location}::{problem.message}"
    location = problem.path + (f":{problem.line}" if problem.line else "")
    return f"{location}: {problem.severity}: {problem.message}"


def main() -> int:
    style: OutputStyle = "github" if os.environ.get("GITHUB_ACTIONS") else "plain"
    base = os.environ.get("TURBO_SCM_BASE", DEFAULT_BASE)
    problems = find_problems(REPO_ROOT, base)
    for problem in problems:
        print(format_problem(problem, style))

    errors = sum(1 for problem in problems if problem.severity == "error")
    if errors:
        print(f"{errors} migration problem(s) against {base}.")
        return 1
    print(f"{MIGRATIONS_DIR}: nothing the hosted database would refuse, against {base}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
