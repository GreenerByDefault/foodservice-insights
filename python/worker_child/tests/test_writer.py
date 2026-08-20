import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from worker_child import contract
from worker_child.writer import progress_reporter, write_json_atomically


def files_in(directory: Path) -> list[str]:
    """Names of the files in `directory`, ignoring the subdirectories the parent created."""
    return sorted(path.name for path in directory.iterdir() if path.is_file())


@pytest.fixture
def run_directory(tmp_path: Path) -> Path:
    """A run directory as the parent builds it: every directory present, no files."""
    for relative in contract.DIRECTORIES_CREATED_BY_PARENT:
        (tmp_path / relative).mkdir(parents=True)
    return tmp_path


def test_leaves_no_temporary_file_behind(run_directory: Path) -> None:
    path = run_directory / contract.PROGRESS
    write_json_atomically(path, {"sequence": 1})

    assert json.loads(path.read_text(encoding="utf-8")) == {"sequence": 1}
    assert files_in(path.parent) == ["progress.json"]


def test_replaces_rather_than_truncating(run_directory: Path) -> None:
    path = run_directory / contract.PROGRESS
    write_json_atomically(path, {"sequence": 1})
    first_inode = path.stat().st_ino

    write_json_atomically(path, {"sequence": 2})

    assert path.stat().st_ino != first_inode
    assert json.loads(path.read_text(encoding="utf-8"))["sequence"] == 2


def test_refuses_to_write_nan(run_directory: Path) -> None:
    # Python emits a bare `NaN`, which `JSON.parse` rejects.
    path = run_directory / contract.RESULT
    with pytest.raises(ValueError):
        write_json_atomically(path, {"resultMetadata": float("nan")})

    assert not path.exists()
    assert files_in(path.parent) == []


def test_reports_progress_with_a_strictly_increasing_sequence(run_directory: Path) -> None:
    advance = progress_reporter(run_directory)
    path = run_directory / contract.PROGRESS

    assert advance() == 1
    assert json.loads(path.read_text(encoding="utf-8"))["sequence"] == 1
    assert [advance(), advance()] == [2, 3]
    assert json.loads(path.read_text(encoding="utf-8"))["sequence"] == 3


def test_survives_concurrent_writers_to_the_same_path(run_directory: Path) -> None:
    path = run_directory / contract.RESULT
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda i: write_json_atomically(path, {"resultMetadata": i}), range(50)))
    assert files_in(path.parent) == ["result.json"]


def test_progress_reporter_is_safe_for_concurrent_callers(run_directory: Path) -> None:
    advance = progress_reporter(run_directory)
    path = run_directory / contract.PROGRESS

    with ThreadPoolExecutor(max_workers=8) as pool:
        sequences = list(pool.map(lambda _: advance(), range(100)))

    # The lock keeps the in-memory counter and the file monotonic together: every call gets a
    # distinct sequence number, and the file on disk ends up agreeing with the highest one.
    assert sorted(sequences) == list(range(1, 101))
    assert json.loads(path.read_text(encoding="utf-8"))["sequence"] == max(sequences)


def test_each_run_reports_its_own_sequence(run_directory: Path, tmp_path_factory) -> None:
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
