"""The seven documents that cross the run directory: the child parses `run.json` and
`categorization-cache.json`, and builds the other five as payload dicts."""

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final

from gbd_foodservice_insights.analysis import (
    CachedCategorization,
    CategorizationSummary,
    InputSummary,
    ListedFinding,
    MonthlyCounts,
    NewCategorization,
    ReportSummary,
    cost_micro_usd,
)

from worker_child.contract import ContractError
from worker_child.contract.fields import Fields, parse_object
from worker_child.contract.layout import CATEGORIZATION_CACHE, MANIFEST
from worker_child.contract.names import (
    CHILD_FAILURE_REASONS,
    COUNTS_BASES,
    CUSTOMER_FINDING_STATUSES,
    MAX_FINDING_SAMPLE_VALUES,
    MAX_FINDING_TEXT_BYTES,
    MAX_PRODUCT_BYTES,
    STAGES,
    UNIT_SYSTEMS,
    ChildFailureReason,
    LlmOperation,
    Stage,
    UnitSystem,
)

MONTH_PATTERN = re.compile(r"\d{4}-(0[1-9]|1[0-2])")
UUID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
# The `analysis_attempt_llm_usage_*_model_format` CHECKs.
MODEL_PATTERN = re.compile(r"[a-z0-9][a-z0-9._:-]{0,99}")
# Every count in `telemetry.json` lands in a Postgres `integer`.
MAX_POSTGRES_INTEGER: Final = 2**31 - 1


@dataclass(frozen=True)
class ReportInputs:
    name: str | None
    site_name: str | None
    organization_name: str
    unit_system: UnitSystem
    counts: MonthlyCounts | None  # `None` when the uploader chose not to give counts


@dataclass(frozen=True)
class RunManifest:
    analysis_attempt_id: str
    report: ReportInputs


def read_run_manifest(run_directory: Path) -> RunManifest:
    return parse_run_manifest(_read_input(run_directory, MANIFEST))


def read_categorization_cache(run_directory: Path) -> tuple[CachedCategorization, ...]:
    return parse_categorization_cache(_read_input(run_directory, CATEGORIZATION_CACHE))


def _read_input(run_directory: Path, relative: str) -> str:
    try:
        return (run_directory / relative).read_text(encoding="utf-8")
    except OSError as error:
        raise ContractError(f"{relative}: {error}") from error


def parse_run_manifest(text: str) -> RunManifest:
    root = parse_object("run.json", text)
    analysis_attempt_id = root.matching("analysisAttemptId", UUID_PATTERN)
    report = root.nested("report")
    counts = report.nullable_nested("counts")

    manifest = RunManifest(
        analysis_attempt_id=analysis_attempt_id,
        report=ReportInputs(
            name=report.nullable_string("name"),
            site_name=report.nullable_string("siteName"),
            organization_name=report.string("organizationName"),
            unit_system=report.literal("unitSystem", UNIT_SYSTEMS),
            counts=None if counts is None else _monthly_counts(counts),
        ),
    )

    report.done()
    root.done()
    return manifest


def _monthly_counts(counts: Fields) -> MonthlyCounts:
    parsed = MonthlyCounts(
        basis=counts.literal("basis", COUNTS_BASES),
        monthly=counts.counts("monthly", MONTH_PATTERN),
    )
    counts.done()
    return parsed


def parse_categorization_cache(text: str) -> tuple[CachedCategorization, ...]:
    root = parse_object("categorization-cache.json", text)
    rows = tuple(_cached_categorization(row) for row in root.objects("rows"))
    root.done()
    return rows


def _cached_categorization(row: Fields) -> CachedCategorization:
    cached = CachedCategorization(
        product=row.string("product"),
        category=row.string("category"),
        cleaned_name=row.nullable_string("cleanedName"),
    )
    row.done()
    return cached


def progress_payload(sequence: int) -> dict[str, Any]:
    if sequence < 1:
        raise ContractError(f"progress.json: sequence must be >= 1, got {sequence}")
    return {"sequence": sequence}


def result_payload(
    *, analysis_attempt_id: str, findings: Sequence[ListedFinding]
) -> dict[str, Any]:
    """Refuses any finding the parent would: `contract/fixtures/invalid/result.*` pin each rule."""
    _require(UUID_PATTERN.fullmatch(analysis_attempt_id), "analysisAttemptId is not a uuid")

    return {
        "analysisAttemptId": analysis_attempt_id,
        "findings": [_finding_payload(finding) for finding in findings],
    }


def _finding_payload(finding: ListedFinding) -> dict[str, Any]:
    _require(
        finding.status in CUSTOMER_FINDING_STATUSES,
        f"{finding.quality_check}: the customer is not shown a {finding.status!r} finding",
    )
    _require(finding.message, f"{finding.quality_check}: the message is empty")
    _require(
        len(finding.sample_values) <= MAX_FINDING_SAMPLE_VALUES,
        f"{finding.quality_check}: {len(finding.sample_values)} samples, over "
        f"{MAX_FINDING_SAMPLE_VALUES}",
    )
    for text in (finding.message, *finding.sample_values):
        _require("\0" not in text, f"{finding.quality_check}: {text[:40]!r}... holds a NUL")
        _require(
            len(text.encode("utf-8")) <= MAX_FINDING_TEXT_BYTES,
            f"{finding.quality_check}: {text[:40]!r}... is over {MAX_FINDING_TEXT_BYTES} bytes",
        )
    return {
        "qualityCheck": finding.quality_check,
        "status": finding.status,
        "message": finding.message,
        "sampleValues": list(finding.sample_values),
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


def new_categorizations_payload(
    *, analysis_attempt_id: str, rows: Sequence[NewCategorization]
) -> dict[str, Any]:
    """Refuses anything the parent's insert into `product_categorization` would, since one bad row
    fails its whole chunk: `contract/fixtures/invalid/new-categorizations.*` pin each rule."""
    _require(UUID_PATTERN.fullmatch(analysis_attempt_id), "analysisAttemptId is not a uuid")
    products = [row.product for row in rows]
    _require(len(set(products)) == len(products), "new-categorizations.json: a product repeats")
    return {
        "analysisAttemptId": analysis_attempt_id,
        "rows": [_new_categorization_payload(row) for row in rows],
    }


def _new_categorization_payload(row: NewCategorization) -> dict[str, Any]:
    _require(
        row.product and row.product == row.product.strip(),
        f"product {row.product!r} is blank or has surrounding whitespace",
    )
    _require(
        len(row.product.encode("utf-8")) <= MAX_PRODUCT_BYTES,
        f"product {row.product[:40]!r}... is over {MAX_PRODUCT_BYTES} bytes",
    )
    _require(
        row.category and row.category == row.category.strip(),
        f"category {row.category!r} of {row.product!r} is blank or has surrounding whitespace",
    )
    # A blank cleaned name is the LLM's slip, not a reason to fail the report.
    cleaned_name = row.cleaned_name if row.cleaned_name and row.cleaned_name.strip() else None
    return {"product": row.product, "cleanedName": cleaned_name, "category": row.category}


@dataclass(frozen=True)
class LlmUsage:
    """Every `LlmCall` of one operation on one requested model, summed."""

    operation: LlmOperation
    requested_model: str
    served_model: str | None  # the latest that answered
    calls: int
    requests: int
    failed_requests: int
    rate_limited_requests: int
    truncated_calls: int
    input_tokens: int
    cached_input_tokens: int
    output_tokens: int


@dataclass(frozen=True)
class TelemetryState:
    """What the run has reported so far. A summary is `None` until its stage finishes."""

    llm_usage: Mapping[tuple[LlmOperation, str], LlmUsage] = field(default_factory=dict)
    input: InputSummary | None = None
    categorization: CategorizationSummary | None = None
    report: ReportSummary | None = None
    stage_duration_ms: Mapping[Stage, int] = field(default_factory=dict)


def telemetry_payload(state: TelemetryState, *, peak_memory_kib: int) -> dict[str, Any]:
    """Refuses anything the parent's insert would: each rule mirrors a CHECK on the telemetry
    tables, which `contract/fixtures/invalid/telemetry.*` pin on the parent's side."""
    _require(
        state.categorization is None or state.input is not None,
        "categorization reported before input",
    )
    _require(
        state.report is None or state.categorization is not None,
        "report reported before categorization",
    )
    stage_duration_ms: dict[str, int] = {
        stage: state.stage_duration_ms[stage]
        for stage in STAGES
        if stage in state.stage_duration_ms
    }
    _require(
        list(stage_duration_ms) == list(STAGES[: len(stage_duration_ms)]),
        f"a stage finished before the one ahead of it: {', '.join(stage_duration_ms)}",
    )
    _require_counts("stageDurationMs", stage_duration_ms)
    _require_counts("telemetry.json", {"peakMemoryKib": peak_memory_kib}, minimum=1)

    return {
        "llmUsage": [_llm_usage_payload(usage) for _, usage in sorted(state.llm_usage.items())],
        "input": None if state.input is None else _input_payload(state.input),
        "categorization": (
            None
            if state.categorization is None or state.input is None
            else _categorization_payload(state.categorization, state.input)
        ),
        "report": None if state.report is None else _report_payload(state.report),
        "stageDurationMs": stage_duration_ms,
        "peakMemoryKib": peak_memory_kib,
    }


def _llm_usage_payload(usage: LlmUsage) -> dict[str, Any]:
    _require(
        MODEL_PATTERN.fullmatch(usage.requested_model),
        f"{usage.requested_model!r} is not a model id",
    )
    _require(
        usage.served_model is None or MODEL_PATTERN.fullmatch(usage.served_model),
        f"{usage.served_model!r} is not a model id",
    )
    counts = {
        "calls": usage.calls,
        "requests": usage.requests,
        "failedRequests": usage.failed_requests,
        "rateLimitedRequests": usage.rate_limited_requests,
        "truncatedCalls": usage.truncated_calls,
        "inputTokens": usage.input_tokens,
        "cachedInputTokens": usage.cached_input_tokens,
        "outputTokens": usage.output_tokens,
    }
    _require_counts("llmUsage", counts)
    _require(usage.calls >= 1, "llmUsage: a row needs at least one call")
    _require(
        usage.requests >= usage.failed_requests >= usage.rate_limited_requests,
        "llmUsage: needs requests >= failedRequests >= rateLimitedRequests",
    )
    # Only a call's last request can succeed.
    _require(
        usage.requests - usage.failed_requests <= usage.calls,
        "llmUsage: needs at most one successful request per call",
    )
    _require(usage.truncated_calls <= usage.calls, "llmUsage: needs truncatedCalls <= calls")
    _require(
        usage.cached_input_tokens <= usage.input_tokens,
        "llmUsage: needs cachedInputTokens <= inputTokens",
    )
    # From the totals, so the cost is rounded once rather than once per call.
    cost = cost_micro_usd(
        usage.requested_model,
        input_tokens=usage.input_tokens,
        cached_input_tokens=usage.cached_input_tokens,
        output_tokens=usage.output_tokens,
    )
    _require_counts("llmUsage", {"costMicroUsd": cost})
    return {
        "operation": usage.operation,
        "requestedModel": usage.requested_model,
        "servedModel": usage.served_model,
        **counts,
        "costMicroUsd": cost,
    }


def _input_payload(summary: InputSummary) -> dict[str, Any]:
    counts = {
        "rows": summary.rows,
        "uniqueProducts": summary.unique_products,
        "categorizationCacheEntries": summary.categorization_cache_entries,
    }
    _require_counts("input", counts)
    _require_quantity("input.kilograms", summary.kilograms)
    return {**counts, "kilograms": summary.kilograms}


def _categorization_payload(
    summary: CategorizationSummary, input_summary: InputSummary
) -> dict[str, Any]:
    counts = {
        "cacheRawNameProducts": summary.cache_raw_name_products,
        "cacheCleanedNameProducts": summary.cache_cleaned_name_products,
        "llmMatchedProducts": summary.llm_matched_products,
        "cacheNoMatchProducts": summary.cache_no_match_products,
        "llmNoMatchProducts": summary.llm_no_match_products,
        "unrecognizedLlmAnswers": summary.unrecognized_llm_answers,
        "categorizedRows": summary.categorized_rows,
    }
    _require_counts("categorization", counts)
    _require_quantity("categorization.categorizedKilograms", summary.categorized_kilograms)
    matched = (
        summary.cache_raw_name_products
        + summary.cache_cleaned_name_products
        + summary.llm_matched_products
    )
    _require(
        matched == input_summary.unique_products,
        f"categorization: the match types sum to {matched}, not the "
        f"{input_summary.unique_products} unique products read",
    )
    _require(
        summary.categorized_rows <= input_summary.rows,
        f"categorization: {summary.categorized_rows} rows categorized of {input_summary.rows} read",
    )
    return {**counts, "categorizedKilograms": summary.categorized_kilograms}


def _report_payload(summary: ReportSummary) -> dict[str, Any]:
    _require_quantity("report.totalCo2eKg", summary.total_co2e_kg)
    if summary.co2e_kg_per_diner_or_meal is not None:
        _require_quantity("report.co2eKgPerDinerOrMeal", summary.co2e_kg_per_diner_or_meal)
    _require_percentage("report.plantPctByWeight", summary.plant_pct_by_weight)
    if summary.plant_protein_pct_by_weight is not None:
        _require_percentage("report.plantProteinPctByWeight", summary.plant_protein_pct_by_weight)
    pairs = [(count.quality_check, count.status) for count in summary.finding_counts]
    _require(len(set(pairs)) == len(pairs), "report: each quality check and status at most once")
    _require_counts(
        "report.findingCounts",
        {
            f"{quality_check}/{status}": count.findings
            for (quality_check, status), count in zip(pairs, summary.finding_counts, strict=True)
        },
        minimum=1,
    )
    return {
        "totalCo2eKg": summary.total_co2e_kg,
        "co2eKgPerDinerOrMeal": summary.co2e_kg_per_diner_or_meal,
        "plantPctByWeight": summary.plant_pct_by_weight,
        "plantProteinPctByWeight": summary.plant_protein_pct_by_weight,
        "findingCounts": [
            {
                "qualityCheck": count.quality_check,
                "status": count.status,
                "findings": count.findings,
            }
            for count in summary.finding_counts
        ],
    }


def _require_counts(path: str, counts: Mapping[str, int], *, minimum: int = 0) -> None:
    for name, value in counts.items():
        _require(
            # `bool` subclasses `int` and would be written as `true`; a float may be fractional.
            # The type checker lets both through, and the parent refuses both.
            isinstance(value, int)
            and not isinstance(value, bool)
            and minimum <= value <= MAX_POSTGRES_INTEGER,
            f"{path}.{name} must be an integer in [{minimum}, {MAX_POSTGRES_INTEGER}], "
            f"got {value!r}",
        )


def _require_quantity(path: str, value: float) -> None:
    _require(math.isfinite(value) and value >= 0, f"{path} must be finite and >= 0, got {value}")


def _require_percentage(path: str, value: float) -> None:
    _require(0 <= value <= 100, f"{path} must be in [0, 100], got {value}")


def _require(condition: object, problem: str) -> None:
    if not condition:
        raise ContractError(problem)
