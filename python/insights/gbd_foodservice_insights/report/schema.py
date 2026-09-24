"""Shared schema and enums for food report generation."""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from typing import Any, Literal

ReportMode = Literal["procurement", "serving"]
MissingDataPolicy = Literal["warn_continue", "hard_fail"]
DiagnosticStatus = Literal["success", "info", "warning", "error"]
QualityStatus = Literal["pass", "warning", "invalid"]

VALID_REPORT_MODES: tuple[ReportMode, ...] = ("procurement", "serving")
VALID_REGIONS: tuple[str, ...] = ("us", "europe", "uk")

# Maps each valid region to whether dates should be parsed day-first (DD/MM/YYYY).
# When adding a new region, add it to VALID_REGIONS above and to this dict.
REGION_DAYFIRST: dict[str, bool] = {
    "us": False,
    "europe": True,
    "uk": True,
}
VALID_MISSING_DATA_POLICIES: tuple[MissingDataPolicy, ...] = (
    "warn_continue",
    "hard_fail",
)

REQUIRED_COLUMNS_BY_MODE: dict[ReportMode, tuple[str, ...]] = {
    "procurement": ("date", "product", "category", "kilos_total"),
    "serving": ("date", "product", "category", "servings total"),
}

# Required non-null fields are stricter than required columns.
REQUIRED_NON_NULL_COLUMNS_BY_MODE: dict[ReportMode, tuple[str, ...]] = {
    "procurement": ("date", "product", "category", "kilos_total"),
    "serving": ("date", "product", "category", "servings total"),
}

STATUS_SEVERITY: dict[DiagnosticStatus, int] = {
    "success": 0,
    "info": 1,
    "warning": 2,
    "error": 3,
}


def normalize_report_mode(value: str | None) -> ReportMode:
    """Normalize arbitrary procurement/serving text into a canonical mode."""
    if value is None:
        return "procurement"

    normalized = str(value).strip().lower()
    if normalized in VALID_REPORT_MODES:
        return normalized

    if "serv" in normalized:
        return "serving"
    return "procurement"


def validate_report_mode(mode: str) -> ReportMode:
    """Validate and return report mode."""
    normalized = normalize_report_mode(mode)
    if normalized not in VALID_REPORT_MODES:
        raise ValueError(f"Unsupported report mode '{mode}'. Valid modes: {VALID_REPORT_MODES}")
    return normalized


def metric_for_mode(mode: ReportMode) -> str:
    """Return canonical total metric column for a report mode."""
    return "servings total" if mode == "serving" else "kilos_total"


def required_columns_for_mode(mode: ReportMode) -> tuple[str, ...]:
    """Return required input columns for mode."""
    return REQUIRED_COLUMNS_BY_MODE[mode]


def required_non_null_columns_for_mode(mode: ReportMode) -> tuple[str, ...]:
    """Return columns that must not contain missing values for mode."""
    return REQUIRED_NON_NULL_COLUMNS_BY_MODE[mode]


def metric_display_label(metric: str) -> str:
    """Return a human-readable display label from an internal metric column name.

    Strips '_total' or ' total' suffixes and replaces underscores with spaces.

    Examples::

        metric_display_label('kilos_total')   # → 'Kilos'
        metric_display_label('serving total') # → 'Serving'
        metric_display_label('kilos_co2e')    # → 'Kilos Co2E'
    """
    return metric.replace("_total", "").replace(" total", "").replace("_", " ").strip().title()


def per_diner_metric_name(total_metric: str) -> str:
    """Return per-diner metric column name from a total metric name.

    Handles both underscore-style ('kilos_total' → 'kilos per diner-meal')
    and space-style ('kilos total' → 'kilos per diner-meal') conventions.
    """
    if total_metric.endswith("_total"):
        base = total_metric[: -len("_total")]
        return f"{base} per diner-meal"
    if " total" in total_metric:
        return total_metric.replace(" total", "") + " per diner-meal"
    raise ValueError(f"Expected metric name to end with '_total' or ' total', got '{total_metric}'")


def validate_region(region: str) -> str:
    """Validate and normalize region identifier."""
    normalized = str(region).strip().lower()
    if normalized not in VALID_REGIONS:
        raise ValueError(f"region must be one of {list(VALID_REGIONS)}, got '{region}'")
    return normalized


def validate_missing_data_policy(policy: str | None) -> MissingDataPolicy:
    """Validate missing-data policy string."""
    if policy is None:
        return "warn_continue"
    normalized = str(policy).strip().lower()
    if normalized not in VALID_MISSING_DATA_POLICIES:
        raise ValueError(
            f"missing_data_policy must be one of {list(VALID_MISSING_DATA_POLICIES)}, "
            f"got '{policy}'"
        )
    return normalized  # type: ignore[return-value]


def quality_status_from_findings(findings: Iterable[dict[str, Any]]) -> QualityStatus:
    """Compute overall quality status from finding severities."""
    statuses = [str(item.get("status", "info")) for item in findings]
    if any(status == "error" for status in statuses):
        return "invalid"
    if any(status in {"warning", "info"} for status in statuses):
        return "warning"
    return "pass"


def summarize_status_counts(findings: Iterable[dict[str, Any]]) -> dict[str, int]:
    """Count findings by status."""
    counter = Counter(str(item.get("status", "info")) for item in findings)
    return {
        "success": counter.get("success", 0),
        "info": counter.get("info", 0),
        "warning": counter.get("warning", 0),
        "error": counter.get("error", 0),
    }


def should_fail_now(policy: MissingDataPolicy, findings: Iterable[dict[str, Any]]) -> bool:
    """Whether execution should abort under the chosen missing-data policy."""
    if policy != "hard_fail":
        return False
    return any(str(item.get("status", "")) == "error" for item in findings)
