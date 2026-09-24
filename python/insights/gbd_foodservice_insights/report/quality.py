"""Quality-audit helpers for the food-report pipeline."""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from typing import Any

import pandas as pd

from gbd_foodservice_insights.report.schema import (
    MissingDataPolicy,
    should_fail_now,
    summarize_status_counts,
)


def make_finding(
    *,
    stage: str,
    category: str,
    status: str,
    message: str,
    column: str | None = None,
    count: int | None = None,
    sample_values: list[Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a standardized structured finding."""
    finding: dict[str, Any] = {
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


def check_required_columns(
    df: pd.DataFrame,
    required_columns: Iterable[str],
    *,
    stage: str,
) -> list[dict[str, Any]]:
    """Create error finding for missing required columns."""
    missing = [col for col in required_columns if col not in df.columns]
    if not missing:
        return []

    return [
        make_finding(
            stage=stage,
            category="required_columns",
            status="error",
            message=f"Missing required columns: {missing}",
            metadata={"missing_columns": missing},
        )
    ]


def check_required_non_null(
    df: pd.DataFrame,
    required_non_null_columns: Iterable[str],
    *,
    stage: str,
    sample_limit: int = 5,
) -> list[dict[str, Any]]:
    """Create findings for required columns that contain missing values."""
    findings: list[dict[str, Any]] = []
    sample_context_cols = ["date", "month_year", "product", "category"]
    for column in required_non_null_columns:
        if column not in df.columns:
            continue
        missing_mask = df[column].isna()
        missing_count = int(missing_mask.sum())
        if missing_count == 0:
            continue

        # dict.fromkeys de-duplicates while keeping order: when the checked column is itself
        # one of the context columns, listing it twice makes pandas drop a column from the
        # sample rows and emit a "columns are not unique" warning.
        sample_cols = list(
            dict.fromkeys(col for col in [*sample_context_cols, column] if col in df.columns)
        )
        sample_rows = (
            df.loc[missing_mask, sample_cols]
            .head(sample_limit)
            .replace({pd.NA: None})
            .to_dict("records")
        )
        findings.append(
            make_finding(
                stage=stage,
                category="required_non_null",
                status="error",
                message=(
                    f"Column '{column}' has {missing_count} missing values in a required "
                    "non-null field."
                ),
                column=column,
                count=missing_count,
                metadata={"sample_rows": sample_rows},
            )
        )

    return findings


def missing_snapshot(df: pd.DataFrame) -> dict[str, int]:
    """Return NA counts for all columns."""
    return {column: int(df[column].isna().sum()) for column in df.columns}


def compare_missing_snapshots(
    before: dict[str, int],
    after: dict[str, int],
    *,
    stage: str,
) -> list[dict[str, Any]]:
    """Create findings for newly-introduced missingness between snapshots."""
    findings: list[dict[str, Any]] = []
    for column, after_count in after.items():
        before_count = before.get(column, 0)
        introduced = after_count - before_count
        if introduced > 0:
            findings.append(
                make_finding(
                    stage=stage,
                    category="new_missing_values",
                    status="warning",
                    message=f"Column '{column}' has {introduced} newly introduced missing values.",
                    column=column,
                    count=int(introduced),
                    metadata={"before": int(before_count), "after": int(after_count)},
                )
            )
    return findings


def check_row_count_drift(
    before_rows: int,
    after_rows: int,
    *,
    stage: str,
) -> list[dict[str, Any]]:
    """Report row-count drift between stages."""
    if before_rows == after_rows:
        return []

    delta = after_rows - before_rows
    drift_label = "lost" if delta < 0 else "gained"
    return [
        make_finding(
            stage=stage,
            category="row_count_drift",
            status="error",
            message=(
                f"Row count changed unexpectedly from {before_rows} to {after_rows} "
                f"(delta: {delta}). This stage should preserve rows, so rows may have been "
                f"{drift_label} silently."
            ),
            count=abs(delta),
            metadata={"before_rows": before_rows, "after_rows": after_rows, "delta": delta},
        )
    ]


def findings_to_frame(findings: Iterable[dict[str, Any]]) -> pd.DataFrame:
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


def summarize_findings(findings: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Build compact quality summary payload."""
    rows = list(findings)
    by_stage = Counter(item.get("stage", "unknown") for item in rows)
    return {
        "total_findings": len(rows),
        "by_status": summarize_status_counts(rows),
        "by_stage": {str(key): int(value) for key, value in by_stage.items()},
    }


def enforce_policy_or_raise(
    policy: MissingDataPolicy,
    findings: Iterable[dict[str, Any]],
) -> None:
    """Raise ValueError if policy requires fail-fast and errors are present."""
    rows = list(findings)
    if not should_fail_now(policy, rows):
        return

    messages = [
        f"[{item.get('stage', 'unknown')}::{item.get('category', 'unknown')}] "
        f"{item.get('message', '')}"
        for item in rows
        if item.get("status") == "error"
    ]
    raise ValueError(
        "missing_data_policy='hard_fail' aborted report generation due to error findings:\n"
        + "\n".join(messages)
    )
