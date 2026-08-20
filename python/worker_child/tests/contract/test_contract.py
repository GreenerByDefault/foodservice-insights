from pathlib import Path

import pytest
from support.contract_fixtures import CONTRACT, REPO_ROOT
from worker_child.contract import ContractError, layout, names


def test_repo_root_resolved_to_the_right_place() -> None:
    assert (REPO_ROOT / "pnpm-workspace.yaml").is_file()


def test_agrees_on_how_the_child_is_invoked() -> None:
    assert CONTRACT["invocation"] == {
        "module": names.MODULE,
        "positionalArguments": list(names.POSITIONAL_ARGUMENTS),
        "workingDirectory": names.WORKING_DIRECTORY,
        "environmentVariables": list(names.ENVIRONMENT_VARIABLES),
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
        "usageError": names.EXIT_USAGE_ERROR,
    }


def test_require_created_by_parent_accepts_a_complete_run_directory(tmp_path: Path) -> None:
    for relative in layout.DIRECTORIES_CREATED_BY_PARENT:
        (tmp_path / relative).mkdir(parents=True)

    layout.require_created_by_parent(tmp_path)  # does not raise


def test_require_created_by_parent_names_every_missing_directory(tmp_path: Path) -> None:
    (tmp_path / "input").mkdir()

    with pytest.raises(ContractError) as excinfo:
        layout.require_created_by_parent(tmp_path)

    assert str(excinfo.value) == "run directory is missing output, output/files, work"


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
