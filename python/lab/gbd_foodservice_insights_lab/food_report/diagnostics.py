"""QA-workbook-only diagnostics for the food-report bundle."""

import numpy as np
import pandas as pd


def summarise_numeric_columns(
    df: pd.DataFrame,
    numeric_columns: list[str] | None = None,
) -> pd.DataFrame:
    """Summarize specified numeric columns in a DataFrame.

    Returns one row per column with mean, median, max, min, and counts of negative values,
    zeros, and NaN values. ``numeric_columns`` defaults to every numeric column; a ``page``
    column is always excluded.
    """
    if numeric_columns is None:
        cols: list[str] = df.select_dtypes(include=[np.number]).columns.tolist()
    else:
        if not isinstance(numeric_columns, list):
            raise ValueError("numeric_columns must be a list of column names or None")
        cols = numeric_columns

    cols = [c for c in cols if isinstance(c, str) and c.lower() != "page"]

    summary_data = []
    for col in cols:
        if col not in df.columns:
            raise AssertionError(f"Column '{col}' not found in DataFrame")
        series = df[col]
        summary_data.append(
            {
                "column": col,
                "mean": round(series.mean(), 4),
                "median": round(series.median(), 4),
                "highest": round(series.max(), 4),
                "lowest": round(series.min(), 4),
                "negative_values_count": int((series < 0).sum()),
                "zero_count": int((series == 0).sum()),
                "nan_count": int(series.isna().sum()),
            }
        )

    return pd.DataFrame(summary_data)
