#!/usr/bin/env python3
"""Check that every exclusion in `.github/filters.yml` still describes reality.

An exclusion naming a path that no longer exists is worse than no exclusion: it reads as
deliberate while excluding nothing, and nobody notices. So, every negated glob must match at
least one tracked file, unless marked `# planned`, in which case it must match none.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal

REPO_ROOT: Final = Path(__file__).resolve().parents[2]
FILTERS_PATH: Final = ".github/filters.yml"
PLANNED_MARKER: Final = "# planned"

# A filter entry such as:    - '!python/**'   # planned
_EXCLUSION: Final = re.compile(r"^\s*-\s*'!(?P<glob>[^']+)'(?P<trailer>.*)$")

ExclusionStatus = Literal["current", "planned"]
OutputStyle = Literal["plain", "github"]


@dataclass(frozen=True)
class Exclusion:
    """One negated glob in the filter file."""

    line_number: int
    glob: str
    status: ExclusionStatus


def parse_exclusions(lines: Iterable[str]) -> tuple[Exclusion, ...]:
    return tuple(
        Exclusion(
            line_number=number,
            glob=match["glob"],
            status="planned" if PLANNED_MARKER in match["trailer"] else "current",
        )
        for number, line in enumerate(lines, start=1)
        if (match := _EXCLUSION.match(line))
    )


def problem_with(exclusion: Exclusion, tracked: int) -> str | None:
    """What is wrong with this exclusion, or None if it still describes reality."""
    if exclusion.status == "planned":
        if tracked == 0:
            return None
        return (
            f"is marked `{PLANNED_MARKER}` but now matches {tracked} tracked "
            "file(s); the path has arrived, so drop the marker"
        )
    if tracked > 0:
        return None
    return (
        "matches no tracked file; delete the exclusion, or mark it "
        f"`{PLANNED_MARKER}` if the path is still coming"
    )


def format_problem(exclusion: Exclusion, problem: str, style: OutputStyle) -> str:
    message = f"'!{exclusion.glob}' {problem}"
    if style == "github":
        return (
            f"::error file={FILTERS_PATH},line={exclusion.line_number}::{message}"
        )
    return f"{FILTERS_PATH}:{exclusion.line_number}: {message}"


def count_tracked(glob: str) -> int:
    """How many files git tracks under `glob`, using git's own glob semantics."""
    listed = subprocess.run(
        ["git", "ls-files", "-z", "--", f":(glob){glob}"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return sum(1 for path in listed.stdout.split("\0") if path)


def main() -> int:
    style: OutputStyle = "github" if os.environ.get("GITHUB_ACTIONS") else "plain"
    exclusions = parse_exclusions(
        (REPO_ROOT / FILTERS_PATH).read_text(encoding="utf-8").splitlines()
    )
    if not exclusions:
        print(f"{FILTERS_PATH}: no exclusions found; has the format changed?")
        return 1

    problems = [
        format_problem(exclusion, problem, style)
        for exclusion in exclusions
        if (problem := problem_with(exclusion, count_tracked(exclusion.glob)))
    ]
    for line in problems:
        print(line)

    if problems:
        print(
            f"{len(problems)} stale exclusion(s). Read the header comment in "
            f"{FILTERS_PATH} before changing them."
        )
        return 1

    print(f"{FILTERS_PATH}: {len(exclusions)} exclusions, all current.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
