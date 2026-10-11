"""Shared data transformations for the food-report pipeline."""

import pandas as pd


def monthly_totals(
    df: pd.DataFrame,
    value_col: str,
    month_col: str = "month_year",
) -> pd.Series:
    """Monthly totals that preserve all-missing groups as missing.

    Uses ``sum(min_count=1)`` so a month with only missing values remains NaN.
    """
    if month_col not in df.columns:
        raise ValueError(f"Column '{month_col}' not found in DataFrame.")
    if value_col not in df.columns:
        raise ValueError(f"Column '{value_col}' not found in DataFrame.")

    grouped = df.groupby(month_col, dropna=False)[value_col].sum(min_count=1).sort_index()
    return grouped
