import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from worker_child.contract import layout
from worker_child.writer import (
    dump_json,
    progress_reporter,
    write_atomically,
    write_json_atomically,
)


def files_in(directory: Path) -> list[str]:
    """Names of the files in `directory`, ignoring the subdirectories the parent created."""
    return sorted(path.name for path in directory.iterdir() if path.is_file())


@pytest.fixture
def run_directory(tmp_path: Path) -> Path:
    """A run directory as the parent builds it: every directory present, no files."""
    for relative in layout.DIRECTORIES_CREATED_BY_PARENT:
        (tmp_path / relative).mkdir(parents=True)
    return tmp_path


def test_dump_json_encodes_sorted_indented_utf8_with_a_trailing_newline() -> None:
    assert dump_json({"b": 1, "a": "é"}) == '{\n  "a": "é",\n  "b": 1\n}\n'.encode()


def test_dump_json_refuses_nan() -> None:
    # Python emits a bare `NaN`, which `JSON.parse` rejects.
    with pytest.raises(ValueError):
        dump_json({"resultMetadata": float("nan")})


def test_write_atomically_leaves_no_temporary_file_behind(run_directory: Path) -> None:
    path = run_directory / layout.PROGRESS
    write_atomically(path, b"hello")

    assert path.read_bytes() == b"hello"
    assert files_in(path.parent) == ["progress.json"]


def test_write_atomically_replaces_rather_than_truncating(run_directory: Path) -> None:
    path = run_directory / layout.PROGRESS
    write_atomically(path, b"a longer first payload")
    first_inode = path.stat().st_ino

    write_atomically(path, b"second")

    assert path.stat().st_ino != first_inode
    assert path.read_bytes() == b"second"


def test_write_atomically_cleans_up_the_temporary_file_on_failure(
    run_directory: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = run_directory / layout.PROGRESS

    def broken_fsync(_: int) -> None:
        raise OSError("disk full")

    monkeypatch.setattr("worker_child.writer.os.fsync", broken_fsync)

    with pytest.raises(OSError):
        write_atomically(path, b"partial")

    assert not path.exists()
    assert files_in(path.parent) == []


def test_write_atomically_survives_concurrent_writers_to_the_same_path(run_directory: Path) -> None:
    path = run_directory / layout.RESULT
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda i: write_atomically(path, str(i).encode()), range(50)))
    assert files_in(path.parent) == ["result.json"]


def test_write_json_atomically_writes_the_encoded_payload(run_directory: Path) -> None:
    path = run_directory / layout.PROGRESS
    write_json_atomically(path, {"sequence": 1})
    assert json.loads(path.read_text(encoding="utf-8")) == {"sequence": 1}


def test_write_json_atomically_rejects_nan_before_touching_the_filesystem(
    run_directory: Path,
) -> None:
    path = run_directory / layout.RESULT
    with pytest.raises(ValueError):
        write_json_atomically(path, {"resultMetadata": float("nan")})

    assert not path.exists()
    assert files_in(path.parent) == []


def test_reports_progress_with_a_strictly_increasing_sequence(run_directory: Path) -> None:
    advance = progress_reporter(run_directory)
    path = run_directory / layout.PROGRESS

    assert advance() == 1
    assert json.loads(path.read_text(encoding="utf-8"))["sequence"] == 1
    assert [advance(), advance()] == [2, 3]
    assert json.loads(path.read_text(encoding="utf-8"))["sequence"] == 3


def test_progress_reporter_is_safe_for_concurrent_callers(run_directory: Path) -> None:
    advance = progress_reporter(run_directory)
    path = run_directory / layout.PROGRESS

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
        json.loads((run_directory / layout.PROGRESS).read_text(encoding="utf-8"))["sequence"] == 2
    )
