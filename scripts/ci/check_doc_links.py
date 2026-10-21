#!/usr/bin/env python3
"""Check that every reference to a doc still lands on something.

1. A relative Markdown link resolves to a tracked file or directory.
2. A link's `#anchor` matches a heading in the target, slugged as GitHub slugs it.
3. Outside Markdown, a citation `<doc>.md § <Heading>` names a doc that exists and a heading in
   it. The text after `§` must begin with the heading in full, so an abbreviation fails. A bare
   filename such as `README.md` may mean the one in any directory above the citing file. A
   heading that begins another one hides the longer one's rename: "§ Worker queue" still
   begins "Worker".

This catches a reference left behind by a move or a rename, not a doc that has stopped being
true; that is still the job of whoever changes the code.
"""

from __future__ import annotations

import os
import posixpath
import re
import subprocess
import sys
from collections import Counter
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Final, Literal
from urllib.parse import unquote

REPO_ROOT: Final = Path(__file__).resolve().parents[2]

# Never checked as a source of references, though anything may be a target. Plans describe files
# that do not exist yet, the Svelte skill is vendored from upstream, and this script's tests
# break references on purpose.
UNCHECKED_PREFIXES: Final = (
    ".claude/plans/",
    ".claude/skills/svelte-core-bestpractices/",
    "scripts/ci/tests/",
)

_FENCE: Final = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_INLINE_CODE: Final = re.compile(r"(`+).+?\1")
_HEADING: Final = re.compile(r"^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$")
_LINK_IN_HEADING: Final = re.compile(r"\[([^\]]*)\]\([^)]*\)")
# A destination may hold one level of balanced parentheses, as in `routes/(app)/+page.svelte`.
_INLINE_LINK: Final = re.compile(r"\]\(\s*(?:<([^>]*)>|((?:[^()\s]|\([^()\s]*\))+))")
_REFERENCE_DEFINITION: Final = re.compile(r"^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)")
_SCHEME: Final = re.compile(r"^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|//)")
_CITATION: Final = re.compile(r"([\w./-]+\.md)[`'\")\]]*\s*§\s*(.*)")
_COMMENT_LEADER: Final = re.compile(r"^\s*(?://+|#+|\*+|--|<!--)?\s*")

OutputStyle = Literal["plain", "github"]


@dataclass(frozen=True)
class Reference:
    """A link's destination, or a citation's doc plus the text after its `§`."""

    line_number: int
    target: str
    section: str = ""


@dataclass(frozen=True)
class Problem:
    path: str
    line_number: int
    message: str


def prose_lines(markdown: str) -> Iterator[tuple[int, str]]:
    """Each line outside frontmatter and fenced code."""
    lines = markdown.split("\n")
    start = lines.index("---", 1) + 1 if lines[0] == "---" and "---" in lines[1:] else 0
    fence = ""
    for number, line in enumerate(lines[start:], start=start + 1):
        if match := _FENCE.match(line):
            marker = match[1]
            if not fence:
                fence = marker
            elif marker[0] == fence[0] and len(marker) >= len(fence):
                fence = ""
            continue
        if not fence:
            yield number, line


def heading_texts(markdown: str) -> tuple[str, ...]:
    return tuple(
        _LINK_IN_HEADING.sub(r"\1", match[1]).replace("`", "")
        for _, line in prose_lines(markdown)
        if (match := _HEADING.match(line))
    )


def anchors(headings: Iterable[str]) -> frozenset[str]:
    """GitHub's slugs: a repeated heading gets `-1`, `-2`, … after the first."""
    seen: Counter[str] = Counter()
    slugs = set()
    for heading in headings:
        slug = re.sub(r"[^\w\- ]", "", heading.strip().lower()).replace(" ", "-")
        slugs.add(f"{slug}-{seen[slug]}" if seen[slug] else slug)
        seen[slug] += 1
    return frozenset(slugs)


def links(markdown: str) -> Iterator[Reference]:
    for number, line in prose_lines(markdown):
        prose = _INLINE_CODE.sub("", line)
        destinations = [m[1] or m[2] for m in _INLINE_LINK.finditer(prose)]
        if match := _REFERENCE_DEFINITION.match(prose):
            destinations.append(match[1])
        for destination in destinations:
            if destination and not _SCHEME.match(destination):
                yield Reference(number, unquote(destination))


def citations(text: str) -> Iterator[Reference]:
    """Each `<doc>.md § <Heading>`, with the next line appended in case the heading wraps."""
    lines = text.split("\n")
    for index, line in enumerate(lines):
        following = lines[index + 1] if index + 1 < len(lines) else ""
        for match in _CITATION.finditer(line):
            section = f"{match[2]}\n{_COMMENT_LEADER.sub('', following, count=1)}"
            yield Reference(index + 1, match[1], section)


def words(text: str) -> str:
    return " ".join(re.sub(r"[^\w ]", " ", text.lower()).split())


def cites_heading(section: str, headings: Iterable[str]) -> bool:
    cited = words(section)
    return any(
        cited == heading or cited.startswith(f"{heading} ")
        for heading in map(words, headings)
        if heading
    )


def candidate_docs(citing_path: str, doc: str) -> tuple[str, ...]:
    """Where `doc` might live: from the root, beside the citer, or, if bare, in any ancestor."""
    directory = posixpath.dirname(citing_path)
    candidates = [posixpath.normpath(doc), posixpath.normpath(posixpath.join(directory, doc))]
    if "/" not in doc:
        while directory:
            directory = posixpath.dirname(directory)
            candidates.append(posixpath.join(directory, doc))
    return tuple(dict.fromkeys(candidates))


@dataclass
class Tree:
    """The files git knows about, under `root`, with each doc's headings read once."""

    root: Path
    files: frozenset[str]
    _headings: dict[str, tuple[str, ...]] = field(default_factory=dict)

    @cached_property
    def directories(self) -> frozenset[str]:
        return frozenset(
            posixpath.dirname(path[: index + 1])
            for path in self.files
            for index, character in enumerate(path)
            if character == "/"
        )

    def exists(self, path: str) -> bool:
        return path in self.files or path in self.directories or path == "."

    def read(self, path: str) -> str:
        return (self.root / path).read_text(encoding="utf-8")

    def headings(self, path: str) -> tuple[str, ...]:
        if path not in self._headings:
            self._headings[path] = heading_texts(self.read(path))
        return self._headings[path]


def link_problems(tree: Tree, path: str) -> Iterator[Problem]:
    for link in links(tree.read(path)):
        target, _, anchor = link.target.partition("#")
        if target.startswith("/"):
            resolved = posixpath.normpath(target.lstrip("/"))
        elif target:
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
        else:
            resolved = path
        if not tree.exists(resolved):
            yield Problem(path, link.line_number, f"links to `{target}`, which does not exist")
        elif (
            anchor
            and resolved in tree.files
            and resolved.endswith(".md")
            and anchor.lower() not in anchors(tree.headings(resolved))
        ):
            yield Problem(
                path, link.line_number, f"links to `#{anchor}`: no such heading in {resolved}"
            )


def citation_problems(tree: Tree, path: str) -> Iterator[Problem]:
    for citation in citations(tree.read(path)):
        docs = [doc for doc in candidate_docs(path, citation.target) if doc in tree.files]
        if not docs:
            yield Problem(
                path, citation.line_number, f"cites `{citation.target}`, which does not exist"
            )
        elif not any(cites_heading(citation.section, tree.headings(doc)) for doc in docs):
            cited, _, _ = citation.section.partition("\n")
            yield Problem(
                path,
                citation.line_number,
                f"cites a section of {' or '.join(docs)} that no heading starts: "
                f"`§ {cited.strip()}`. Give the heading in full.",
            )


def all_problems(tree: Tree, citing: Iterable[str]) -> list[Problem]:
    markdown = (
        path
        for path in tree.files
        if path.endswith(".md") and not path.startswith(UNCHECKED_PREFIXES)
    )
    return sorted(
        [
            *(problem for path in markdown for problem in link_problems(tree, path)),
            *(problem for path in citing for problem in citation_problems(tree, path)),
        ],
        key=lambda problem: (problem.path, problem.line_number),
    )


def git_paths(*args: str) -> list[str]:
    listed = subprocess.run(
        ["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=False
    )
    # `git grep` exits 1 when nothing matches.
    if listed.returncode not in (0, 1):
        raise RuntimeError(listed.stderr)
    return [path for path in listed.stdout.split("\0") if path]


def format_problem(problem: Problem, style: OutputStyle) -> str:
    if style == "github":
        return f"::error file={problem.path},line={problem.line_number}::{problem.message}"
    return f"{problem.path}:{problem.line_number}: {problem.message}"


def main() -> int:
    style: OutputStyle = "github" if os.environ.get("GITHUB_ACTIONS") else "plain"
    # Untracked files count, so a doc written but not yet added is not reported missing.
    listed = git_paths("ls-files", "-z", "--cached", "--others", "--exclude-standard")
    tree = Tree(REPO_ROOT, frozenset(path for path in listed if (REPO_ROOT / path).is_file()))
    excluded = [f":(exclude){prefix}" for prefix in UNCHECKED_PREFIXES]
    citing = git_paths(
        "grep", "-l", "-z", "-I", "--untracked", "-E", r"\.md[^§]{0,3}§", "--",
        ":(exclude)*.md", *excluded,
    )  # fmt: skip

    problems = all_problems(tree, (path for path in citing if path in tree.files))
    for problem in problems:
        print(format_problem(problem, style))

    if problems:
        print(f"{len(problems)} broken doc reference(s).")
        return 1

    print(f"Every doc link and citation lands ({len(citing)} files cite a doc section).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
