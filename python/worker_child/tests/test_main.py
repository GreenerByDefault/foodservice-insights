"""See `test_child_process.py` for how the three test files here divide coverage. This one
spawns the real `python -m worker_child` entrypoint, but only for paths that never reach
`analyze()` — argv handling and manifest problems the parent could produce."""

import json
import subprocess
import sys
from pathlib import Path

import pytest
from worker_child.contract import layout, names

INVALID_RUN_FIXTURES = sorted(
    path.name
    for path in (Path(__file__).resolve().parents[3] / "contract" / "fixtures" / "invalid").glob(
        "run.*.json"
    )
)


@pytest.fixture
def run_directory(tmp_path: Path) -> Path:
    for relative in layout.DIRECTORIES_CREATED_BY_PARENT:
        (tmp_path / relative).mkdir(parents=True)
    return tmp_path


def spawn(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "worker_child", *args],
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_no_arguments_is_a_usage_error() -> None:
    result = spawn()

    assert result.returncode == names.EXIT_USAGE_ERROR
    assert "usage" in result.stderr.lower()
    assert result.stdout == ""


def test_two_arguments_is_a_usage_error(tmp_path: Path) -> None:
    result = spawn(str(tmp_path), str(tmp_path))

    assert result.returncode == names.EXIT_USAGE_ERROR
    assert "usage" in result.stderr.lower()
    assert result.stdout == ""


def test_a_missing_manifest_is_a_contract_violation(run_directory: Path) -> None:
    result = spawn(str(run_directory))

    assert result.returncode == names.EXIT_WROTE_FAILURE
    failure = json.loads((run_directory / layout.FAILURE).read_text(encoding="utf-8"))
    assert failure["reason"] == "contract_violation"
    assert not (run_directory / layout.RESULT).exists()


# One fixture is enough to prove a schema violation reaches `failure.json` through the real
# process; `test_fixtures.py::test_rejects_an_invalid_fixture` covers the rest, in-process.
def test_a_schema_violation_in_the_manifest_is_a_contract_violation(run_directory: Path) -> None:
    fixtures = Path(__file__).resolve().parents[3] / "contract" / "fixtures" / "invalid"
    (run_directory / layout.MANIFEST).write_text(
        (fixtures / INVALID_RUN_FIXTURES[0]).read_text(encoding="utf-8"), encoding="utf-8"
    )

    result = spawn(str(run_directory))

    assert result.returncode == names.EXIT_WROTE_FAILURE
    failure = json.loads((run_directory / layout.FAILURE).read_text(encoding="utf-8"))
    assert failure["reason"] == "contract_violation"
