"""The four documents that cross the run directory: the child parses `run.json` and builds the
other three as payload dicts."""

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

from worker_child.contract import ContractError
from worker_child.contract.fields import parse_object
from worker_child.contract.layout import MANIFEST, require_chart_key
from worker_child.contract.names import (
    CHILD_FAILURE_REASONS,
    COUNTS_BASES,
    UNIT_SYSTEMS,
    ChildFailureReason,
    CountsBasis,
    UnitSystem,
)

MONTH_PATTERN = re.compile(r"\d{4}-(0[1-9]|1[0-2])")
SHA_256_PATTERN = re.compile(r"[0-9a-f]{64}")
UUID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

# The parent stores `ai_cost_usd` as `numeric(10,4)` and enforces it with `^\d{1,6}\.\d{4}$`, so
# anything at or above 1,000,000 is a contract violation the parent would reject after a full,
# fully-paid-for run.
MAXIMUM_COST_USD = Decimal("1000000")


@dataclass(frozen=True)
class ReportInputs:
    name: str | None
    site_name: str | None
    counts_basis: CountsBasis
    unit_system: UnitSystem
    monthly_counts: Mapping[str, int]


@dataclass(frozen=True)
class InputFileFacts:
    """What the parent says it put in `input.csv`. Parsed but never used: `AnalysisRequest` has
    no slot for these, and nothing verifies the CSV against them. They are validated anyway so
    that a manifest the parent got wrong fails at startup rather than midway through a paid run.
    """

    original_filename: str
    byte_size: int
    checksum_sha256: str


@dataclass(frozen=True)
class RunManifest:
    analysis_attempt_id: str
    report: ReportInputs
    input_file: InputFileFacts


@dataclass(frozen=True)
class AiUsage:
    model: str
    input_tokens: int
    output_tokens: int
    # `ai_cost_usd` is `numeric(10,4)`; a float would lose precision crossing to JSON.
    cost_usd: Decimal
    metadata: Mapping[str, Any]


def read_run_manifest(run_directory: Path) -> RunManifest:
    manifest_path = run_directory / MANIFEST
    try:
        text = manifest_path.read_text(encoding="utf-8")
    except OSError as error:
        raise ContractError(f"{MANIFEST}: {error}") from error
    return parse_run_manifest(text)


def parse_run_manifest(text: str) -> RunManifest:
    root = parse_object("run.json", text)
    analysis_attempt_id = root.matching("analysisAttemptId", UUID_PATTERN)
    report = root.nested("report")
    input_file = root.nested("inputFile")

    manifest = RunManifest(
        analysis_attempt_id=analysis_attempt_id,
        report=ReportInputs(
            name=report.nullable_string("name"),
            site_name=report.nullable_string("siteName"),
            counts_basis=report.literal("countsBasis", COUNTS_BASES),
            unit_system=report.literal("unitSystem", UNIT_SYSTEMS),
            monthly_counts=report.counts("monthlyCounts", MONTH_PATTERN),
        ),
        input_file=InputFileFacts(
            original_filename=input_file.string("originalFilename"),
            byte_size=input_file.integer("byteSize", minimum=1),
            checksum_sha256=input_file.matching("checksumSha256", SHA_256_PATTERN),
        ),
    )

    report.done()
    input_file.done()
    root.done()
    return manifest


def progress_payload(sequence: int) -> dict[str, Any]:
    if sequence < 1:
        raise ContractError(f"progress.json: sequence must be >= 1, got {sequence}")
    return {"sequence": sequence}


def result_payload(
    *,
    analysis_attempt_id: str,
    charts: Sequence[str],
    ai: AiUsage,
    result_metadata: Mapping[str, Any],
) -> dict[str, Any]:
    _require(UUID_PATTERN.fullmatch(analysis_attempt_id), "analysisAttemptId is not a uuid")
    for chart_key in charts:
        require_chart_key(chart_key)
    _require(len(set(charts)) == len(charts), "chart keys must be unique")
    _require(ai.input_tokens >= 0 and ai.output_tokens >= 0, "token counts must not be negative")
    _require(0 <= ai.cost_usd < MAXIMUM_COST_USD, f"cost must be within [0, {MAXIMUM_COST_USD})")

    return {
        "analysisAttemptId": analysis_attempt_id,
        "charts": list(charts),
        "ai": {
            "model": ai.model,
            "inputTokens": ai.input_tokens,
            "outputTokens": ai.output_tokens,
            "costUsd": f"{ai.cost_usd:.4f}",
            "metadata": _opaque(ai.metadata, "ai.metadata"),
        },
        "resultMetadata": _opaque(result_metadata, "resultMetadata"),
    }


def failure_payload(
    *,
    reason: ChildFailureReason,
    detail: str,
    traceback: str | None = None,
) -> dict[str, Any]:
    _require(reason in CHILD_FAILURE_REASONS, f"'{reason}' is not a reason a child may claim")
    _require(bool(detail), "detail must not be empty")
    return {"reason": reason, "detail": detail, "traceback": traceback}


def _opaque(value: Mapping[str, Any], name: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractError(f"{name} must be a JSON object")
    return dict(value)


def _require(condition: object, problem: str) -> None:
    if not condition:
        raise ContractError(problem)
