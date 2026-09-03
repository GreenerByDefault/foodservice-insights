"""The four documents that cross the run directory: the child parses `run.json` and builds the
other three as payload dicts."""

import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from worker_child.contract import ContractError
from worker_child.contract.fields import parse_object
from worker_child.contract.layout import MANIFEST
from worker_child.contract.names import (
    CHILD_FAILURE_REASONS,
    COUNTS_BASES,
    UNIT_SYSTEMS,
    ChildFailureReason,
    CountsBasis,
    UnitSystem,
)

MONTH_PATTERN = re.compile(r"\d{4}-(0[1-9]|1[0-2])")
UUID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


@dataclass(frozen=True)
class ReportInputs:
    name: str | None
    site_name: str | None
    counts_basis: CountsBasis
    unit_system: UnitSystem
    monthly_counts: Mapping[str, int]


@dataclass(frozen=True)
class RunManifest:
    analysis_attempt_id: str
    report: ReportInputs


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

    manifest = RunManifest(
        analysis_attempt_id=analysis_attempt_id,
        report=ReportInputs(
            name=report.nullable_string("name"),
            site_name=report.nullable_string("siteName"),
            counts_basis=report.literal("countsBasis", COUNTS_BASES),
            unit_system=report.literal("unitSystem", UNIT_SYSTEMS),
            monthly_counts=report.counts("monthlyCounts", MONTH_PATTERN),
        ),
    )

    report.done()
    root.done()
    return manifest


def progress_payload(sequence: int) -> dict[str, Any]:
    if sequence < 1:
        raise ContractError(f"progress.json: sequence must be >= 1, got {sequence}")
    return {"sequence": sequence}


def result_payload(*, analysis_attempt_id: str) -> dict[str, Any]:
    _require(UUID_PATTERN.fullmatch(analysis_attempt_id), "analysisAttemptId is not a uuid")

    return {"analysisAttemptId": analysis_attempt_id}


def failure_payload(
    *,
    reason: ChildFailureReason,
    detail: str,
    traceback: str | None = None,
) -> dict[str, Any]:
    _require(reason in CHILD_FAILURE_REASONS, f"'{reason}' is not a reason a child may claim")
    _require(bool(detail), "detail must not be empty")
    return {"reason": reason, "detail": detail, "traceback": traceback}


def _require(condition: object, problem: str) -> None:
    if not condition:
        raise ContractError(problem)
