"""Shared schema and enums for food report generation."""

from collections import Counter
from collections.abc import Iterable
from typing import Any, Literal

ReportMode = Literal["procurement", "serving"]
Region = Literal["us", "europe"]
DinerOrMeal = Literal["diner", "meal"]
DiagnosticStatus = Literal["success", "info", "warning", "error"]
QualityStatus = Literal["pass", "warning", "invalid"]

VALID_REPORT_MODES: tuple[ReportMode, ...] = ("procurement", "serving")
VALID_REGIONS: tuple[Region, ...] = ("us", "europe")

REQUIRED_COLUMNS_BY_MODE: dict[ReportMode, tuple[str, ...]] = {
    "procurement": ("date", "product", "category", "kilos_total"),
    "serving": ("date", "product", "category", "servings total"),
}

STATUS_SEVERITY: dict[DiagnosticStatus, int] = {
    "success": 0,
    "info": 1,
    "warning": 2,
    "error": 3,
}


def metric_for_mode(mode: ReportMode) -> str:
    """Return canonical total metric column for a report mode."""
    return "servings total" if mode == "serving" else "kilos_total"


def required_columns_for_mode(mode: ReportMode) -> tuple[str, ...]:
    """Return required input columns for mode."""
    return REQUIRED_COLUMNS_BY_MODE[mode]


def required_non_null_columns_for_mode(mode: ReportMode) -> tuple[str, ...]:
    """Return columns that must not contain missing values for mode."""
    return REQUIRED_COLUMNS_BY_MODE[mode]


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


def validate_region(region: str) -> Region:
    """Validate and normalize region identifier."""
    normalized = str(region).strip().lower()
    if normalized not in VALID_REGIONS:
        raise ValueError(f"region must be one of {list(VALID_REGIONS)}, got '{region}'")
    return normalized


def quality_status_from_findings(findings: Iterable[dict[str, Any]]) -> QualityStatus:
    """Compute overall quality status from finding severities; ``info`` never counts."""
    statuses = {str(item.get("status", "info")) for item in findings}
    if "error" in statuses:
        return "invalid"
    if "warning" in statuses:
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
