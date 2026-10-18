"""Quality-audit helpers for the food-report pipeline."""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Final, Literal, NotRequired, TypedDict

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


# How many findings a report lists, and examples of each; the rest are only counted.
MAX_LISTED_FINDINGS: Final = 20
MAX_LISTED_SAMPLES: Final = 5


@dataclass(frozen=True)
class ListedFinding:
    quality_check: QualityCheck
    status: DiagnosticStatus
    message: str
    sample_values: tuple[str, ...]


def listed_findings(
    findings: Sequence[Finding], *, show_successes: bool
) -> tuple[ListedFinding, ...]:
    """The findings the PDF's quality page lists, in its order. Without ``show_successes`` (the
    customer's report), only warnings and errors."""
    visible = [f for f in findings if show_successes or f["status"] in {"warning", "error"}]
    return tuple(
        ListedFinding(
            quality_check=finding["category"],
            status=finding["status"],
            message=finding["message"],
            sample_values=tuple(
                str(value) for value in finding.get("sample_values", [])[:MAX_LISTED_SAMPLES]
            ),
        )
        for finding in visible[:MAX_LISTED_FINDINGS]
    )
