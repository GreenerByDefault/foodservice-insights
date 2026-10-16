"""See `test_child_process.py` for how the three test files here divide coverage. This one
drives `run()` directly with `stub_analysis`: no subprocess, so it's where the success path
and every failure reason `run()` maps get covered case by case."""

import json
import shutil
from pathlib import Path

import pytest
from gbd_foodservice_insights.analysis import (
    AnalysisError,
    AnalysisRequest,
    InputSummary,
    InvalidInputError,
    NewCategorization,
    StageFinished,
    UnusableDataError,
    UpstreamApiError,
)
from gbd_foodservice_insights.testing import stub_analysis
from support.contract_fixtures import VALID_ANALYSIS_ATTEMPT_ID, VALID_CATEGORIZATION_CACHE
from worker_child.contract import layout, names
from worker_child.contract.messages import parse_categorization_cache
from worker_child.run import run


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_writes_a_result_and_exits_zero_on_a_successful_analysis(run_directory: Path) -> None:
    exit_code = run(run_directory, analyze=stub_analysis)

    assert exit_code == names.EXIT_WROTE_RESULT
    assert read_json(run_directory / layout.RESULT) == {
        "analysisAttemptId": VALID_ANALYSIS_ATTEMPT_ID,
    }
    assert not (run_directory / layout.FAILURE).exists()


def test_places_result_files_under_contract_names(run_directory: Path) -> None:
    run(run_directory, analyze=stub_analysis)

    files_directory = run_directory / layout.RESULT_FILES_DIRECTORY
    assert (files_directory / layout.PDF_FILE_NAME).read_bytes().startswith(b"%PDF")
    assert (files_directory / layout.XLSX_FILE_NAME).is_file()


def test_writes_no_new_categorizations_for_a_stub_analysis(run_directory: Path) -> None:
    run(run_directory, analyze=stub_analysis)

    assert read_json(run_directory / layout.NEW_CATEGORIZATIONS) == {
        "analysisAttemptId": VALID_ANALYSIS_ATTEMPT_ID,
        "rows": [],
    }


def test_writes_the_new_categorizations_the_analysis_returns(run_directory: Path) -> None:
    rows = (
        NewCategorization("Pork Loin", "pork loin", "Pork (pig meat)"),
        NewCategorization("Paper Towels", None, "No Matches Found"),
    )

    def analyze(request: AnalysisRequest, *, report_progress, report_telemetry):
        return stub_analysis(request, new_categorizations=rows)

    run(run_directory, analyze=analyze)

    assert read_json(run_directory / layout.NEW_CATEGORIZATIONS) == {
        "analysisAttemptId": VALID_ANALYSIS_ATTEMPT_ID,
        "rows": [
            {"product": "Pork Loin", "cleanedName": "pork loin", "category": "Pork (pig meat)"},
            {"product": "Paper Towels", "cleanedName": None, "category": "No Matches Found"},
        ],
    }


def test_a_product_repeated_in_the_new_categorizations_is_a_contract_violation(
    run_directory: Path,
) -> None:
    rows = (NewCategorization("Pork Loin", "pork", "Pork (pig meat)"),) * 2

    def analyze(request: AnalysisRequest, *, report_progress, report_telemetry):
        return stub_analysis(request, new_categorizations=rows)

    exit_code = run(run_directory, analyze=analyze)

    assert exit_code == names.EXIT_WROTE_FAILURE
    assert read_json(run_directory / layout.FAILURE)["reason"] == "contract_violation"
    assert not (run_directory / layout.RESULT).exists()


def test_reports_progress_once_per_report_progress_call(run_directory: Path) -> None:
    def analyze(request: AnalysisRequest, *, report_progress, report_telemetry):
        return stub_analysis(request, report_progress=report_progress, progress_calls=3)

    run(run_directory, analyze=analyze)
    assert read_json(run_directory / layout.PROGRESS) == {"sequence": 3}


TELEMETRY = (
    StageFinished("read", duration_ms=120),
    InputSummary(rows=36, kilograms=163.5, unique_products=14, categorization_cache_entries=0),
)


def expected_telemetry(written: dict) -> dict:
    return {
        "llmUsage": [],
        "input": {
            "rows": 36,
            "kilograms": 163.5,
            "uniqueProducts": 14,
            "categorizationCacheEntries": 0,
        },
        "categorization": None,
        "report": None,
        "stageDurationMs": {"read": 120},
        # Read from the process at each write, so not a value the test controls.
        "peakMemoryKib": written["peakMemoryKib"],
    }


def test_writes_telemetry_beside_the_result(run_directory: Path) -> None:
    def analyze(request: AnalysisRequest, *, report_progress, report_telemetry):
        return stub_analysis(request, report_telemetry=report_telemetry, telemetry=TELEMETRY)

    exit_code = run(run_directory, analyze=analyze)

    assert exit_code == names.EXIT_WROTE_RESULT
    telemetry = read_json(run_directory / layout.TELEMETRY)
    assert telemetry == expected_telemetry(telemetry)


def test_a_failed_analysis_keeps_the_telemetry_it_reported_first(run_directory: Path) -> None:
    def analyze(request: AnalysisRequest, *, report_progress, report_telemetry):
        return stub_analysis(
            request,
            report_telemetry=report_telemetry,
            telemetry=TELEMETRY,
            raises=UnusableDataError,
        )

    exit_code = run(run_directory, analyze=analyze)

    assert exit_code == names.EXIT_WROTE_FAILURE
    assert read_json(run_directory / layout.FAILURE)["reason"] == "unusable_data"
    telemetry = read_json(run_directory / layout.TELEMETRY)
    assert telemetry == expected_telemetry(telemetry)


def test_an_analysis_that_reports_nothing_writes_no_telemetry(run_directory: Path) -> None:
    run(run_directory, analyze=stub_analysis)

    assert not (run_directory / layout.TELEMETRY).exists()


def test_the_default_analyze_without_an_api_key_fails_as_unknown(
    run_directory: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    exit_code = run(run_directory)  # no `analyze` override: exercises the production default

    assert exit_code == names.EXIT_WROTE_FAILURE
    failure = read_json(run_directory / layout.FAILURE)
    assert failure["reason"] == "unknown"
    assert failure["detail"] == "OPENAI_API_KEY must be set in environment variables"


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


def test_hands_analyze_the_categorization_cache(run_directory: Path) -> None:
    received: list[AnalysisRequest] = []

    def analyze(request: AnalysisRequest, *, report_progress, report_telemetry):
        received.append(request)
        return stub_analysis(request)

    run(run_directory, analyze=analyze)

    assert [request.categorization_cache for request in received] == [
        parse_categorization_cache(VALID_CATEGORIZATION_CACHE)
    ]


def test_writes_a_contract_violation_when_the_categorization_cache_is_missing(
    run_directory: Path,
) -> None:
    (run_directory / layout.CATEGORIZATION_CACHE).unlink()

    exit_code = run(run_directory, analyze=stub_analysis)

    assert exit_code == names.EXIT_WROTE_FAILURE
    failure = read_json(run_directory / layout.FAILURE)
    assert failure["reason"] == "contract_violation"
    assert not (run_directory / layout.RESULT).exists()


def test_writes_a_contract_violation_when_the_categorization_cache_is_malformed(
    run_directory: Path,
) -> None:
    (run_directory / layout.CATEGORIZATION_CACHE).write_text('{"rows": {}}', encoding="utf-8")

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
    def analyze(request: AnalysisRequest, *, report_progress, report_telemetry):
        return stub_analysis(request, report_progress=report_progress, raises=raises)

    exit_code = run(run_directory, analyze=analyze)

    assert exit_code == names.EXIT_WROTE_FAILURE
    assert read_json(run_directory / layout.FAILURE) == {
        "reason": reason,
        "detail": f"stub_analysis: raising {raises.__name__} on request",
        "traceback": None,
    }


def test_maps_an_unexpected_exception_to_unknown_with_a_traceback(run_directory: Path) -> None:
    def analyze(request: AnalysisRequest, *, report_progress, report_telemetry):
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
    def analyze(request: AnalysisRequest, *, report_progress, report_telemetry):
        return stub_analysis(request, report_progress=report_progress, write_pdf=False)

    exit_code = run(run_directory, analyze=analyze)

    assert exit_code == names.EXIT_WROTE_FAILURE
    assert read_json(run_directory / layout.FAILURE)["reason"] == "contract_violation"
    assert not (run_directory / layout.RESULT).exists()


def test_when_failure_json_itself_cannot_be_written_the_exception_propagates(
    run_directory: Path,
) -> None:
    """Documented in `run()`: `_write_failure` runs outside the `try` that catches the
    original error, so a second failure while writing `failure.json` must escape rather than
    be swallowed by that same handler."""
    shutil.rmtree(run_directory)

    with pytest.raises(OSError):
        run(run_directory, analyze=stub_analysis)
