import json
from pathlib import Path
from typing import Any

import pytest
from worker_child.contract import layout, names

REPO_ROOT = Path(__file__).resolve().parents[4]
CONTRACT: dict[str, Any] = json.loads(
    (REPO_ROOT / "contract" / "contract.json").read_text(encoding="utf-8")
)


def test_repo_root_resolved_to_the_right_place() -> None:
    assert (REPO_ROOT / "pnpm-workspace.yaml").is_file()


def test_agrees_on_how_the_child_is_invoked() -> None:
    assert CONTRACT["invocation"] == {
        "module": names.MODULE,
        "positionalArguments": list(names.POSITIONAL_ARGUMENTS),
        "workingDirectory": names.WORKING_DIRECTORY,
        "secretEnvironmentVariables": list(names.SECRET_ENVIRONMENT_VARIABLES),
    }


def test_agrees_on_the_run_directory_layout() -> None:
    assert CONTRACT["runDirectory"] == {
        "manifest": layout.MANIFEST,
        "inputCsv": layout.INPUT_CSV,
        "progress": layout.PROGRESS,
        "result": layout.RESULT,
        "failure": layout.FAILURE,
        "resultFilesDirectory": layout.RESULT_FILES_DIRECTORY,
        "workDirectory": layout.WORK_DIRECTORY,
        "directoriesCreatedByParent": list(layout.DIRECTORIES_CREATED_BY_PARENT),
    }


def test_agrees_on_the_input_csv() -> None:
    assert CONTRACT["inputCsv"] == {
        "columns": list(layout.INPUT_CSV_COLUMNS),
        "dateFormat": layout.INPUT_CSV_DATE_FORMAT,
    }


def test_agrees_on_the_result_file_names() -> None:
    result_files = CONTRACT["resultFiles"]
    assert result_files["pdf"] == layout.PDF_FILE_NAME
    assert result_files["xlsx"] == layout.XLSX_FILE_NAME

    example = result_files["chartExample"]
    assert layout.chart_file_name(example["chartKey"]) == example["fileName"]


def test_agrees_on_the_report_enums() -> None:
    assert CONTRACT["reportEnums"]["countsBasis"] == list(names.COUNTS_BASES)
    assert CONTRACT["reportEnums"]["unitSystem"] == list(names.UNIT_SYSTEMS)


def test_agrees_on_the_exit_codes() -> None:
    assert CONTRACT["exitCodes"] == {
        "wroteResult": names.EXIT_WROTE_RESULT,
        "wroteFailure": names.EXIT_WROTE_FAILURE,
    }


def test_claims_exactly_the_reasons_the_parent_grants_a_child() -> None:
    granted = sorted(
        reason
        for reason, claimant in CONTRACT["failureReasonClaimants"].items()
        if claimant != "parent"
    )
    assert sorted(names.CHILD_FAILURE_REASONS) == granted


@pytest.mark.parametrize(
    "reason",
    ["child_crashed", "hung", "hard_timeout", "infrastructure", "abandoned", "shut_down"],
)
def test_does_not_claim_a_parent_only_reason(reason: str) -> None:
    # The parent saw the kill itself, so a child claiming one of these is not believed.
    assert CONTRACT["failureReasonClaimants"][reason] == "parent"
    assert reason not in names.CHILD_FAILURE_REASONS
