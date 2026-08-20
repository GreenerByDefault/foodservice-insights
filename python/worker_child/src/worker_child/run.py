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
from worker_child.contract.fields import ContractError
from worker_child.contract.messages import (
    AiUsage,
    RunManifest,
    failure_payload,
    parse_run_manifest,
    result_payload,
)
from worker_child.failures import classify
from worker_child.writer import progress_reporter, write_json_atomically

# The real `analyze()` and `stub_analysis` both take `report_progress` as keyword-only with a
# default, but their defaults differ, so `Callable[..., AnalysisOutcome]` is the honest type.
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
    parent treats a declared-but-missing file as a `contract_violation` (`verdict.ts`) — a
    half-written result must never look complete.
    """
    _require_parent_created_directories(run_directory)
    manifest = _read_manifest(run_directory)
    request = _build_request(run_directory, manifest)
    advance = progress_reporter(run_directory)

    def report_progress(stage: str) -> None:
        del stage  # the child writes only `sequence`; see analysis.py's file header
        advance()

    outcome = analyze(request, report_progress=report_progress)

    # Validate the shape of `outcome` before touching the filesystem, so a bad cost or chart
    # key fails without leaving a half-renamed `output/files` behind.
    payload = result_payload(
        analysis_attempt_id=manifest.analysis_attempt_id,
        charts=list(outcome.charts),
        ai=AiUsage(
            model=outcome.ai.model,
            input_tokens=outcome.ai.input_tokens,
            output_tokens=outcome.ai.output_tokens,
            cost_usd=outcome.ai.cost_usd,
            metadata=outcome.ai.metadata,
        ),
        result_metadata=outcome.metadata,
    )
    place_result_files(run_directory, outcome)
    write_json_atomically(run_directory / layout.RESULT, payload)


def _require_parent_created_directories(run_directory: Path) -> None:
    missing = [
        relative
        for relative in layout.DIRECTORIES_CREATED_BY_PARENT
        if not (run_directory / relative).is_dir()
    ]
    if missing:
        raise ContractError(f"run directory is missing {', '.join(missing)}")


def _read_manifest(run_directory: Path) -> RunManifest:
    manifest_path = run_directory / layout.MANIFEST
    try:
        text = manifest_path.read_text(encoding="utf-8")
    except OSError as error:
        raise ContractError(f"{layout.MANIFEST}: {error}") from error
    return parse_run_manifest(text)


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
    reason, detail = classify(error)
    payload = failure_payload(
        reason=reason,
        detail=detail,
        traceback=traceback.format_exc() if reason == "unknown" else None,
    )
    write_json_atomically(run_directory / layout.FAILURE, payload)
