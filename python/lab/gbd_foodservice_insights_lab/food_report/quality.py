"""Quality-audit frames and summaries for the lab's QA workbook and run manifest."""

from collections import Counter
from collections.abc import Iterable
from typing import Any

import pandas as pd
from gbd_foodservice_insights.report.quality import Finding


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
    by_status = Counter(str(item.get("status", "info")) for item in rows)
    by_stage = Counter(item.get("stage", "unknown") for item in rows)
    return {
        "total_findings": len(rows),
        "by_status": {
            status: by_status.get(status, 0) for status in ("success", "info", "warning", "error")
        },
        "by_stage": {str(key): int(value) for key, value in by_stage.items()},
    }
