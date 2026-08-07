"""Writing into the run directory while the parent may be reading it."""

import json
from pathlib import Path

import pytest
from worker_child import contract
from worker_child.writer import progress_reporter, write_json_atomically


def files_in(directory: Path) -> list[str]:
    """Names of the files in `directory`, ignoring the subdirectories the parent created.

    The point of these assertions is that no `.tmp` file survives, so a leftover temporary would
    show up here alongside the document itself.
    """
    return sorted(path.name for path in directory.iterdir() if path.is_file())


@pytest.fixture
def run_directory(tmp_path: Path) -> Path:
    """A run directory as the parent builds it: every directory present, no files."""
    for relative in contract.DIRECTORIES_CREATED_BY_PARENT:
        (tmp_path / relative).mkdir(parents=True)
    return tmp_path


def test_leaves_no_temporary_file_behind(run_directory: Path) -> None:
    path = run_directory / contract.PROGRESS
    write_json_atomically(path, {"contractVersion": 1, "sequence": 1})

    assert json.loads(path.read_text(encoding="utf-8")) == {"contractVersion": 1, "sequence": 1}
    assert files_in(path.parent) == ["progress.json"]


def test_replaces_rather_than_truncating(run_directory: Path) -> None:
    # The parent polls this file while the child rewrites it. Replacing by rename is what makes a
    # torn read impossible: a reader holds the old inode or the new one, never a mixture.
    path = run_directory / contract.PROGRESS
    write_json_atomically(path, {"contractVersion": 1, "sequence": 1})
    first_inode = path.stat().st_ino

    write_json_atomically(path, {"contractVersion": 1, "sequence": 2})

    assert path.stat().st_ino != first_inode
    assert json.loads(path.read_text(encoding="utf-8"))["sequence"] == 2


def test_refuses_to_write_nan(run_directory: Path) -> None:
    # Python emits a bare `NaN`, which `JSON.parse` rejects. A NaN can reach `resultMetadata`
    # from any aggregation over an empty group, so failing here beats handing the parent a
    # document it cannot read.
    path = run_directory / contract.RESULT
    with pytest.raises(ValueError):
        write_json_atomically(path, {"contractVersion": 1, "resultMetadata": float("nan")})

    assert not path.exists()
    assert files_in(path.parent) == []


def test_heartbeats_with_a_strictly_increasing_sequence(run_directory: Path) -> None:
    advance = progress_reporter(run_directory)
    path = run_directory / contract.PROGRESS

    assert advance() == 1
    assert json.loads(path.read_text(encoding="utf-8"))["sequence"] == 1
    assert [advance(), advance()] == [2, 3]
    assert json.loads(path.read_text(encoding="utf-8"))["sequence"] == 3


def test_each_run_reports_its_own_sequence(run_directory: Path, tmp_path_factory) -> None:
    # Up to three children run at once, each in its own directory. Nothing is shared between
    # reporters, so no locking is needed anywhere.
    other = tmp_path_factory.mktemp("other")
    (other / "output").mkdir()

    first = progress_reporter(run_directory)
    second = progress_reporter(other)
    first()
    first()

    assert second() == 1
    assert (
        json.loads((run_directory / contract.PROGRESS).read_text(encoding="utf-8"))["sequence"] == 2
    )
