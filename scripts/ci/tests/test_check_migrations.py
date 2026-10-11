import subprocess
from pathlib import Path

import pytest
from check_migrations import (
    MIGRATIONS_DIR,
    Changes,
    OutputStyle,
    Problem,
    compatibility_problems,
    find_problems,
    format_problem,
    incompatible_changes,
    parse_name_status,
)

INITIAL = f"{MIGRATIONS_DIR}/001_initial_schema.ts"


@pytest.mark.parametrize(
    ("line", "found"),
    [
        (".dropColumn('legacy')", "dropColumn"),
        (".dropTable('legacy')", "dropTable"),
        (".dropType('legacy')", "dropType"),
        (".renameColumn('a', 'b')", "renameColumn"),
        (".renameTo('b')", "renameTo"),
        (".alterColumn('a', (col) => col.setNotNull())", "setNotNull"),
        (".alterColumn('a', (col) => col.setDataType('text'))", "setDataType"),
        ("await sql`DROP TRIGGER t ON report`.execute(db);", "DROP"),
        ("ALTER TABLE report RENAME COLUMN a TO b", "RENAME"),
        ("alter table report alter column a set not null", "SET NOT NULL"),
        ("ALTER TABLE report ALTER COLUMN a TYPE bigint", "ALTER … TYPE"),
        ("ALTER TABLE report ALTER a SET DATA TYPE bigint", "ALTER … TYPE"),
        ("ALTER TABLE report ADD COLUMN a text NOT NULL", "ADD COLUMN … NOT NULL without DEFAULT"),
    ],
)
def test_incompatible_changes_finds_each_shape(line: str, found: str) -> None:
    assert incompatible_changes(f"// header\n{line}\n") == [(2, found)]


@pytest.mark.parametrize(
    "line",
    [
        ".alterColumn('a', (col) => col.dropNotNull())",
        "ALTER TABLE report ALTER COLUMN a DROP NOT NULL",
        "ALTER TABLE report ADD COLUMN a text NOT NULL DEFAULT ''",
        "ALTER TYPE status ADD VALUE 'paused'",
        ".addColumn('a', 'text')",
        "// We used to DROP this; see the commit that added it.",
        " * Never RENAME a column the worker reads.",
        "await sql`SELECT 1`.execute(db); // then DROP the old one",
        "const docs = 'https://example.com'; // RENAME later",
    ],
)
def test_incompatible_changes_ignores_safe_lines(line: str) -> None:
    assert incompatible_changes(line) == []


def test_incompatible_changes_follows_add_column_across_lines() -> None:
    text = """\
await database.schema
  .alterTable('report')
  .addColumn('kind', 'text', (col) =>
    col.notNull(),
  )
  .addColumn('label', 'text', (col) =>
    col.notNull().defaultTo('none'),
  )
  .execute();
"""
    assert incompatible_changes(text) == [(3, "addColumn … notNull() without defaultTo")]


def test_compatibility_problems_accepts_a_marker_on_the_line_or_in_the_comment_above() -> None:
    text = """\
// backwards-compatible-because: nothing reads legacy since #400
await db.schema.dropTable('legacy').execute();
await db.schema.alterTable('a').dropColumn('b').execute(); // backwards-compatible-because: unused
// backwards-compatible-because:
await db.schema.dropTable('other').execute();
// backwards-compatible-because: the worker stopped reading kind in #402,
// and every deployed worker is newer than that.
await db.schema.alterTable('report').dropColumn('kind').execute();
// backwards-compatible-because: this explains the line below, not the drop after it.
await db.schema.createTable('audit').execute();
await db.schema.dropTable('stale').execute();
"""
    assert [problem.line for problem in compatibility_problems("m.ts", text)] == [5, 11]


def test_parse_name_status() -> None:
    output = "\0".join(["A", "new.ts", "M", "edited.ts", "D", "gone.ts", "R087", "old.ts", "re.ts"])
    assert parse_name_status(output + "\0") == Changes(
        added=("new.ts", "re.ts"), modified=("edited.ts",), removed=("gone.ts", "old.ts")
    )


@pytest.mark.parametrize(
    ("problem", "style", "expected"),
    [
        (Problem("a.ts", 3, "bad"), "plain", "a.ts:3: error: bad"),
        (Problem("a.ts", None, "bad", "warning"), "plain", "a.ts: warning: bad"),
        (Problem("a.ts", 3, "bad"), "github", "::error file=a.ts,line=3::bad"),
        (Problem("a.ts", None, "bad"), "github", "::error file=a.ts::bad"),
    ],
)
def test_format_problem(problem: Problem, style: OutputStyle, expected: str) -> None:
    assert format_problem(problem, style) == expected


# ------------------------------------------------------------------
# Against a real repository
# ------------------------------------------------------------------


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


def write(repo: Path, path: str, text: str = "export async function up() {}\n") -> None:
    (repo / path).parent.mkdir(parents=True, exist_ok=True)
    (repo / path).write_text(text, encoding="utf-8")


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A repo whose `main` has two migrations and a helper, checked out on a branch."""
    git(tmp_path, "init", "--initial-branch=main")
    git(tmp_path, "config", "user.email", "test@example.com")
    git(tmp_path, "config", "user.name", "Test")
    write(tmp_path, INITIAL)
    write(tmp_path, f"{MIGRATIONS_DIR}/002_add_kind.ts")
    write(tmp_path, f"{MIGRATIONS_DIR}/_shared.ts")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "base")
    git(tmp_path, "switch", "-c", "feature")
    return tmp_path


def locations(problems: list[Problem]) -> list[tuple[str, int | None, str]]:
    return [(p.path, p.line, p.severity) for p in problems]


def test_find_problems_passes_a_clean_new_migration(repo: Path) -> None:
    write(repo, f"{MIGRATIONS_DIR}/003_add_label.ts")
    write(repo, f"{MIGRATIONS_DIR}/_more_helpers.ts")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "feature")
    assert find_problems(repo, "main") == []


def test_find_problems_reports_every_check(repo: Path) -> None:
    out_of_order = f"{MIGRATIONS_DIR}/002_add_index.ts"
    misnamed = f"{MIGRATIONS_DIR}/add_owner.ts"
    breaking = f"{MIGRATIONS_DIR}/003_drop_kind.ts"
    # Distinct contents, or git pairs a deletion below with one of these as a rename.
    write(repo, out_of_order, "export async function up() { /* index */ }\n")
    write(repo, misnamed, "export async function up() { /* owner */ }\n")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "feature")
    git(repo, "rm", "-q", f"{MIGRATIONS_DIR}/002_add_kind.ts")
    write(repo, INITIAL, "// a comment fix\nexport async function up() {}\n")
    # Untracked: a branch's newest migration is often not committed yet.
    write(repo, breaking, "await db.schema.alterTable('report').dropColumn('kind').execute();\n")

    assert locations(find_problems(repo, "main")) == [
        (misnamed, None, "error"),
        (out_of_order, None, "error"),
        (f"{MIGRATIONS_DIR}/002_add_kind.ts", None, "error"),
        (INITIAL, None, "warning"),
        (breaking, 1, "error"),
    ]


def test_find_problems_compares_against_the_base_branch_tip(repo: Path) -> None:
    write(repo, f"{MIGRATIONS_DIR}/003_add_label.ts")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "feature")
    git(repo, "switch", "-q", "main")
    write(repo, f"{MIGRATIONS_DIR}/003_add_owner.ts")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "landed first")
    git(repo, "switch", "-q", "feature")

    assert locations(find_problems(repo, "main")) == [
        (f"{MIGRATIONS_DIR}/003_add_label.ts", None, "error")
    ]
