"""See `test_child_process.py` for how the three test files here divide coverage. This one
drives `run()` directly with `stub_analysis`: no subprocess, so it's where the success path
and every failure reason `run()` maps get covered case by case."""

import json
import shutil
from decimal import Decimal
from pathlib import Path

import pytest
from gbd_foodservice_insights.analysis import (
    AnalysisError,
    AnalysisRequest,
    InvalidInputError,
    UnusableDataError,
    UpstreamApiError,
)
from gbd_foodservice_insights.testing import stub_analysis
from support.contract_fixtures import VALID_ANALYSIS_ATTEMPT_ID
from worker_child.contract import layout, names
from worker_child.run import run


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_writes_a_result_and_exits_zero_on_a_successful_analysis(run_directory: Path) -> None:
    exit_code = run(run_directory, analyze=stub_analysis)

    assert exit_code == names.EXIT_WROTE_RESULT
    assert read_json(run_directory / layout.RESULT) == {
        "analysisAttemptId": VALID_ANALYSIS_ATTEMPT_ID,
        "ai": {
            "model": "gpt-4.1-mini",
            "inputTokens": 1_000,
            "outputTokens": 500,
            "costUsd": "0.5000",
            "metadata": {},
        },
        "resultMetadata": {},
    }
    assert not (run_directory / layout.FAILURE).exists()


def test_places_result_files_under_contract_names(run_directory: Path) -> None:
    run(run_directory, analyze=stub_analysis)

    files_directory = run_directory / layout.RESULT_FILES_DIRECTORY
    assert (files_directory / layout.PDF_FILE_NAME).read_bytes().startswith(b"%PDF")
    assert (files_directory / layout.XLSX_FILE_NAME).is_file()


def test_reports_progress_once_per_report_progress_call(run_directory: Path) -> None:
    def analyze(request: AnalysisRequest, *, report_progress):
        return stub_analysis(request, report_progress=report_progress, progress_calls=3)

    run(run_directory, analyze=analyze)
    assert read_json(run_directory / layout.PROGRESS) == {"sequence": 3}


def test_the_real_analyze_is_not_ported_yet(run_directory: Path) -> None:
    exit_code = run(run_directory)  # no `analyze` override: exercises the production default

    assert exit_code == names.EXIT_WROTE_FAILURE
    failure = read_json(run_directory / layout.FAILURE)
    assert failure["reason"] == "unknown"
    assert failure["detail"] == "gbd_foodservice_insights.analyze is not ported yet"
    assert "NotImplementedError" in failure["traceback"]


def test_writes_a_contract_violation_when_the_manifest_is_missing(run_directory: Path) -> None:
    (run_directory / layout.MANIFEST).unlink()

    exit_code = run(run_directory, analyze=stub_analysis)

    assert exit_code == names.EXIT_WROTE_FAILURE
    failure = read_json(run_directory / layout.FAILURE)
    assert failure["reason"] == "contract_violation"
    assert not (run_directory / layout.RESULT).exists()


def test_writes_a_contract_violation_when_the_manifest_is_malformed(run_directory: Path) -> None:
    (run_directory / layout.MANIFEST).write_text("not json", encoding="utf-8")

    exit_code = run(run_directory, analyze=stub_analysis)

    assert exit_code == names.EXIT_WROTE_FAILURE
    assert read_json(run_directory / layout.FAILURE)["reason"] == "contract_violation"


def test_writes_a_contract_violation_when_a_parent_created_directory_is_missing(
    run_directory: Path,
) -> None:
    (run_directory / "output" / "files").rmdir()

    exit_code = run(run_directory, analyze=stub_analysis)

    assert exit_code == names.EXIT_WROTE_FAILURE
    assert read_json(run_directory / layout.FAILURE)["reason"] == "contract_violation"


@pytest.mark.parametrize(
    ("raises", "reason"),
    [
        (UpstreamApiError, "upstream_api"),
        (UnusableDataError, "unusable_data"),
        (InvalidInputError, "contract_violation"),
    ],
)
def test_maps_each_analysis_error_to_its_reason(
    run_directory: Path, raises: type[AnalysisError], reason: str
) -> None:
    def analyze(request: AnalysisRequest, *, report_progress):
        return stub_analysis(request, report_progress=report_progress, raises=raises)

    exit_code = run(run_directory, analyze=analyze)

    assert exit_code == names.EXIT_WROTE_FAILURE
    assert read_json(run_directory / layout.FAILURE) == {
        "reason": reason,
        "detail": f"stub_analysis: raising {raises.__name__} on request",
        "traceback": None,
    }


def test_maps_an_unexpected_exception_to_unknown_with_a_traceback(run_directory: Path) -> None:
    def analyze(request: AnalysisRequest, *, report_progress):
        raise RuntimeError("boom")

    exit_code = run(run_directory, analyze=analyze)

    assert exit_code == names.EXIT_WROTE_FAILURE
    failure = read_json(run_directory / layout.FAILURE)
    assert failure["reason"] == "unknown"
    assert failure["detail"] == "boom"
    assert "RuntimeError" in failure["traceback"]


def test_declaring_a_file_the_library_never_wrote_is_a_contract_violation(
    run_directory: Path,
) -> None:
    def analyze(request: AnalysisRequest, *, report_progress):
        return stub_analysis(request, report_progress=report_progress, write_pdf=False)

    exit_code = run(run_directory, analyze=analyze)

    assert exit_code == names.EXIT_WROTE_FAILURE
    assert read_json(run_directory / layout.FAILURE)["reason"] == "contract_violation"
    assert not (run_directory / layout.RESULT).exists()


def test_a_cost_outside_the_contracts_range_is_a_contract_violation(run_directory: Path) -> None:
    def analyze(request: AnalysisRequest, *, report_progress):
        return stub_analysis(request, report_progress=report_progress, cost_usd=Decimal("1000000"))

    exit_code = run(run_directory, analyze=analyze)

    assert exit_code == names.EXIT_WROTE_FAILURE
    assert read_json(run_directory / layout.FAILURE)["reason"] == "contract_violation"


def test_when_failure_json_itself_cannot_be_written_the_exception_propagates(
    run_directory: Path,
) -> None:
    """Documented in `run()`: `_write_failure` runs outside the `try` that catches the
    original error, so a second failure while writing `failure.json` must escape rather than
    be swallowed by that same handler."""
    shutil.rmtree(run_directory)

    with pytest.raises(OSError):
        run(run_directory, analyze=stub_analysis)
