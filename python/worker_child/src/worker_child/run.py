import traceback
from collections.abc import Callable
from pathlib import Path

from gbd_foodservice_insights.analysis import (
    AnalysisOutcome,
    AnalysisRequest,
)
from gbd_foodservice_insights.analysis import analyze as default_analyze

from worker_child.artifacts import place_result_files
from worker_child.contract import layout, names
from worker_child.contract.messages import (
    RunManifest,
    failure_payload,
    read_run_manifest,
    result_payload,
)
from worker_child.failures import classify_error
from worker_child.writer import progress_reporter, write_json_atomically

# `stub_analysis` takes extra keyword-only params beyond what `analyze()` does,
# so `Callable[..., AnalysisOutcome]` is the honest type.
type Analyze = Callable[..., AnalysisOutcome]


def run(run_directory: Path, analyze: Analyze = default_analyze) -> int:
    """Reads `run.json`, calls the library, and writes exactly one of `result.json` or
    `failure.json`. The only place the exit codes are chosen.

    If `failure.json` itself cannot be written, that exception is left to propagate rather
    than being swallowed here: a traceback on stderr and a nonzero exit reads as
    `child_crashed` with the stderr tail, which diagnoses better than a bare exit 1.
    """
    try:
        _produce_result(run_directory, analyze)
    except Exception as error:
        _write_failure(run_directory, error)
        return names.EXIT_WROTE_FAILURE
    return names.EXIT_WROTE_RESULT


def _produce_result(run_directory: Path, analyze: Analyze) -> None:
    """Ordering is load-bearing: every result file lands before `result.json`, because the
    parent treats a declared-but-missing file as a `contract_violation`.
    """
    layout.require_created_by_parent(run_directory)
    manifest = read_run_manifest(run_directory)
    request = _build_request(run_directory, manifest)

    outcome = analyze(request, report_progress=progress_reporter(run_directory))

    # Validate the shape of `outcome` before touching the filesystem.
    payload = result_payload(
        analysis_attempt_id=manifest.analysis_attempt_id,
        result_metadata=outcome.metadata,
    )
    place_result_files(run_directory, outcome)
    write_json_atomically(run_directory / layout.RESULT, payload)


def _build_request(run_directory: Path, manifest: RunManifest) -> AnalysisRequest:
    return AnalysisRequest(
        run_id=manifest.analysis_attempt_id,
        input_csv=run_directory / layout.INPUT_CSV,
        output_directory=run_directory / layout.RESULT_FILES_DIRECTORY,
        work_directory=run_directory / layout.WORK_DIRECTORY,
        report_name=manifest.report.name,
        site_name=manifest.report.site_name,
        counts_basis=manifest.report.counts_basis,
        unit_system=manifest.report.unit_system,
        monthly_counts=manifest.report.monthly_counts,
    )


def _write_failure(run_directory: Path, error: Exception) -> None:
    reason, detail = classify_error(error)
    payload = failure_payload(
        reason=reason,
        detail=detail,
        traceback=traceback.format_exc() if reason == "unknown" else None,
    )
    write_json_atomically(run_directory / layout.FAILURE, payload)
