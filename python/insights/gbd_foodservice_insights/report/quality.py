"""Quality-audit helpers for the food-report pipeline."""

from typing import Any, NotRequired, TypedDict

from gbd_foodservice_insights.report.schema import DiagnosticStatus


class Finding(TypedDict):
    stage: str
    category: str
    status: DiagnosticStatus
    message: str
    column: NotRequired[str]
    count: NotRequired[int]
    sample_values: NotRequired[list[Any]]
    metadata: NotRequired[dict[str, Any]]


def make_finding(
    *,
    stage: str,
    category: str,
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
