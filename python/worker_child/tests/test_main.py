import json
import subprocess
import sys
from pathlib import Path

import pytest
from worker_child import contract

INVALID_RUN_FIXTURES = sorted(
    path.name
    for path in (Path(__file__).resolve().parents[3] / "contract" / "fixtures" / "invalid").glob(
        "run.*.json"
    )
)


@pytest.fixture
def run_directory(tmp_path: Path) -> Path:
    for relative in contract.DIRECTORIES_CREATED_BY_PARENT:
        (tmp_path / relative).mkdir(parents=True)
    return tmp_path


# Genuine end-to-end runs of the real `python -m worker_child` entrypoint, on paths that
# never reach the library — that stays valid today and forever, because the manifest is
# read before `analyze()` is ever called.
def spawn(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "worker_child", *args],
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_no_arguments_is_a_usage_error() -> None:
    result = spawn()

    assert result.returncode not in (contract.EXIT_WROTE_RESULT, contract.EXIT_WROTE_FAILURE)
    assert "usage" in result.stderr.lower()
    assert result.stdout == ""


def test_two_arguments_is_a_usage_error(tmp_path: Path) -> None:
    result = spawn(str(tmp_path), str(tmp_path))

    assert result.returncode not in (contract.EXIT_WROTE_RESULT, contract.EXIT_WROTE_FAILURE)
    assert "usage" in result.stderr.lower()


def test_a_missing_manifest_is_a_contract_violation(run_directory: Path) -> None:
    result = spawn(str(run_directory))

    assert result.returncode == contract.EXIT_WROTE_FAILURE
    failure = json.loads((run_directory / contract.FAILURE).read_text(encoding="utf-8"))
    assert failure["reason"] == "contract_violation"
    assert not (run_directory / contract.RESULT).exists()


@pytest.mark.parametrize("fixture_name", INVALID_RUN_FIXTURES)
def test_an_invalid_manifest_is_a_contract_violation(
    run_directory: Path, fixture_name: str
) -> None:
    fixtures = Path(__file__).resolve().parents[3] / "contract" / "fixtures" / "invalid"
    (run_directory / contract.MANIFEST).write_text(
        (fixtures / fixture_name).read_text(encoding="utf-8"), encoding="utf-8"
    )

    result = spawn(str(run_directory))

    assert result.returncode == contract.EXIT_WROTE_FAILURE
    failure = json.loads((run_directory / contract.FAILURE).read_text(encoding="utf-8"))
    assert failure["reason"] == "contract_violation"
