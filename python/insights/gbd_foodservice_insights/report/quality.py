"""Quality-audit helpers for the food-report pipeline."""

from typing import Any, Literal, NotRequired, TypedDict

from gbd_foodservice_insights.report.schema import DiagnosticStatus

# The checks `checks.run_all_diagnostics` runs. Closed, so that what is recorded about them can
# name each one.
QualityCheck = Literal[
    "outlier_line_items",
    "per_product_weight_bounds",
    "month_over_month_total_volatility",
    "diner_meal_count_reasonableness",
    "missing_internal_months",
    "date_distribution",
]


class Finding(TypedDict):
    stage: str
    category: QualityCheck
    status: DiagnosticStatus
    message: str
    column: NotRequired[str]
    count: NotRequired[int]
    sample_values: NotRequired[list[Any]]
    metadata: NotRequired[dict[str, Any]]


def make_finding(
    *,
    stage: str,
    category: QualityCheck,
    status: DiagnosticStatus,
    message: str,
    column: str | None = None,
    count: int | None = None,
    sample_values: list[Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> Finding:
    """Build a standardized structured finding."""
    finding: Finding = {
        "stage": stage,
        "category": category,
        "status": status,
        "message": message,
    }
    if column is not None:
        finding["column"] = column
    if count is not None:
        finding["count"] = int(count)
    if sample_values:
        finding["sample_values"] = sample_values
    if metadata:
        finding["metadata"] = metadata
    return finding
