"""Quality-audit helpers for the food-report pipeline."""

from collections import Counter
from collections.abc import Iterable
from typing import Any, NotRequired, TypedDict

import pandas as pd

from gbd_foodservice_insights.report.schema import DiagnosticStatus, summarize_status_counts


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


def findings_to_frame(findings: Iterable[Finding]) -> pd.DataFrame:
    """Convert findings to a DataFrame."""
    rows = list(findings)
    if not rows:
        return pd.DataFrame(columns=["stage", "category", "status", "message"])
    return pd.DataFrame(rows)


def missingness_summary_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Build a column-level missingness summary table."""
    total = len(df)
    rows: list[dict[str, Any]] = []
    for column in df.columns:
        missing = int(df[column].isna().sum())
        rows.append(
            {
                "column": column,
                "missing_count": missing,
                "missing_pct": round((missing / total * 100), 3) if total else 0.0,
                "dtype": str(df[column].dtype),
            }
        )
    return pd.DataFrame(rows).sort_values("missing_count", ascending=False)


def summarize_findings(findings: Iterable[Finding]) -> dict[str, Any]:
    """Build compact quality summary payload."""
    rows = list(findings)
    by_stage = Counter(item.get("stage", "unknown") for item in rows)
    return {
        "total_findings": len(rows),
        "by_status": summarize_status_counts(rows),
        "by_stage": {str(key): int(value) for key, value in by_stage.items()},
    }
