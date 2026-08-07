"""The child's half of the contract, checked against `contract/contract.json`. Renaming a path
here without renaming it in `apps/worker/src/contract/` fails this test — which matters because
`.github/filters.yml` skips every TypeScript job for a Python-only change.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from worker_child import contract

REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACT: dict[str, Any] = json.loads(
    (REPO_ROOT / "contract" / "contract.json").read_text(encoding="utf-8")
)


def test_repo_root_resolved_to_the_right_place() -> None:
    assert (REPO_ROOT / "pnpm-workspace.yaml").is_file()


def test_agrees_on_how_the_child_is_invoked() -> None:
    assert CONTRACT["invocation"] == {
        "module": contract.MODULE,
        "positionalArguments": list(contract.POSITIONAL_ARGUMENTS),
        "workingDirectory": contract.WORKING_DIRECTORY,
        "secretEnvironmentVariables": list(contract.SECRET_ENVIRONMENT_VARIABLES),
    }


def test_agrees_on_the_run_directory_layout() -> None:
    assert CONTRACT["runDirectory"] == {
        "manifest": contract.MANIFEST,
        "inputCsv": contract.INPUT_CSV,
        "progress": contract.PROGRESS,
        "result": contract.RESULT,
        "failure": contract.FAILURE,
        "resultFilesDirectory": contract.RESULT_FILES_DIRECTORY,
        "workDirectory": contract.WORK_DIRECTORY,
        "directoriesCreatedByParent": list(contract.DIRECTORIES_CREATED_BY_PARENT),
    }


def test_agrees_on_the_result_file_names() -> None:
    result_files = CONTRACT["resultFiles"]
    assert result_files["pdf"] == contract.PDF_FILE_NAME
    assert result_files["xlsx"] == contract.XLSX_FILE_NAME

    example = result_files["chartExample"]
    assert contract.chart_file_name(example["chartKey"]) == example["fileName"]


def test_agrees_on_the_report_enums() -> None:
    assert CONTRACT["reportEnums"]["countsBasis"] == list(contract.COUNTS_BASES)
    assert CONTRACT["reportEnums"]["unitSystem"] == list(contract.UNIT_SYSTEMS)


def test_agrees_on_the_exit_codes() -> None:
    assert CONTRACT["exitCodes"] == {
        "wroteResult": contract.EXIT_WROTE_RESULT,
        "wroteFailure": contract.EXIT_WROTE_FAILURE,
    }


def test_claims_exactly_the_reasons_the_parent_grants_a_child() -> None:
    granted = sorted(
        reason
        for reason, claimant in CONTRACT["failureReasonClaimants"].items()
        if claimant != "parent"
    )
    assert sorted(contract.CHILD_FAILURE_REASONS) == granted


@pytest.mark.parametrize("reason", ["child_crashed", "hung", "hard_timeout", "infrastructure"])
def test_does_not_claim_a_parent_only_reason(reason: str) -> None:
    # The parent saw the kill itself, so a child claiming one of these is not believed.
    assert CONTRACT["failureReasonClaimants"][reason] == "parent"
    assert reason not in contract.CHILD_FAILURE_REASONS
