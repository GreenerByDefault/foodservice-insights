from pathlib import Path

import pytest
from check_doc_links import (
    Problem,
    Reference,
    Tree,
    all_problems,
    anchors,
    candidate_docs,
    citations,
    cites_heading,
    heading_texts,
    links,
)


def test_anchors_slug_headings_as_github_does() -> None:
    markdown = "\n".join([
        "---",
        "# a YAML comment, not a heading",
        "---",
        "# Title",
        "## Setup",
        "## Setup",
        "### 1. `raw_data/sample.csv`",
        "## Supabase: database, auth, and blob store",
        "## [Linked](other.md) heading ##",
        "````",
        "```",
        "# inside a fence",
        "````",
    ])  # fmt: skip
    assert anchors(heading_texts(markdown)) == {
        "title",
        "setup",
        "setup-1",
        "1-raw_datasamplecsv",
        "supabase-database-auth-and-blob-store",
        "linked-heading",
    }


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("See [the doc](docs/a.md#part).", ["docs/a.md#part"]),
        ("[page](routes/(app)/+page.svelte)", ["routes/(app)/+page.svelte"]),
        ("[spaced](<a b.md>)", ["a b.md"]),
        ("[ref]: ../up.md", ["../up.md"]),
        ("[encoded](%5Bid%5D.ts)", ["[id].ts"]),
        ("[here](#local)", ["#local"]),
        ("[web](https://example.com) [mail](mailto:a@b.c) <https://x.y>", []),
        ("`[in code](gone.md)`", []),
    ],
)
def test_links(line: str, expected: list[str]) -> None:
    assert [link.target for link in links(line)] == expected


def test_links_skip_fenced_code() -> None:
    assert list(links("```md\n[gone](gone.md)\n```\n[kept](kept.md)")) == [Reference(4, "kept.md")]


def test_citation_keeps_the_next_line_for_a_wrapped_heading() -> None:
    text = "x = 1\n// see `ARCHITECTURE.md` § Supabase: database,\n// auth, and blob store."
    assert list(citations(text)) == [
        Reference(2, "ARCHITECTURE.md", "Supabase: database,\nauth, and blob store.")
    ]


@pytest.mark.parametrize(
    ("section", "cited"),
    [
        ("Supabase: database,\nauth, and blob store. More prose.", True),
        ("Supabase.\n", False),
        ("Auth\n", True),
        ("Authentication\n", False),
        ("\nAuth, which says why.", True),
    ],
)
def test_cites_heading_requires_the_whole_heading(section: str, cited: bool) -> None:
    assert cites_heading(section, ["Supabase: database, auth, and blob store", "Auth"]) == cited


@pytest.mark.parametrize(
    ("citing", "doc", "expected"),
    [
        (
            "apps/web/src/x.ts",
            "README.md",
            ("README.md", "apps/web/src/README.md", "apps/web/README.md", "apps/README.md"),
        ),
        (
            "apps/web/x.ts",
            "packages/db/README.md",
            ("packages/db/README.md", "apps/web/packages/db/README.md"),
        ),
        ("python/lab/x.py", "../../AGENTS.md", ("../../AGENTS.md", "AGENTS.md")),
    ],
)
def test_candidate_docs(citing: str, doc: str, expected: tuple[str, ...]) -> None:
    assert candidate_docs(citing, doc) == expected


def test_all_problems(tmp_path: Path) -> None:
    files = {
        "README.md": "# Root\n## Routes\n[ok](apps/web/README.md#routes) [dir](apps/web)\n"
        "[gone](apps/gone.md) [bad anchor](apps/web/README.md#nope) [self](#root)\n",
        "apps/web/README.md": "# Web\n## Routes\n",
        "apps/web/src/a.ts": "// README.md § Routes, the nearest.\n"
        "// ARCHITECTURE.md § Anything\n"
        "// apps/web/README.md § Rout\n",
        ".claude/plans/p.md": "[future](not/yet.md)\n",
    }
    for path, text in files.items():
        (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / path).write_text(text, encoding="utf-8")

    assert all_problems(Tree(tmp_path, frozenset(files)), ["apps/web/src/a.ts"]) == [
        Problem("README.md", 4, "links to `apps/gone.md`, which does not exist"),
        Problem("README.md", 4, "links to `#nope`: no such heading in apps/web/README.md"),
        Problem("apps/web/src/a.ts", 2, "cites `ARCHITECTURE.md`, which does not exist"),
        Problem(
            "apps/web/src/a.ts",
            3,
            "cites a section of apps/web/README.md that no heading starts: `§ Rout`. "
            "Give the heading in full.",
        ),
    ]
