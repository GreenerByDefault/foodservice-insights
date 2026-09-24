"""Shared data transformations for the food-report pipeline."""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import pandas as pd


def _to_month_period(value: Any, *, context: str) -> pd.Period:
    """Convert one month-like value to a real monthly Period or fail clearly."""
    try:
        period = pd.Period(str(value), freq="M")
    except Exception as exc:
        raise ValueError(f"Invalid {context} month {value!r}: {exc}") from exc

    if not isinstance(period, pd.Period):
        raise ValueError(f"Invalid {context} month {value!r}: value is missing")
    return period


def normalize_diner_meal_mapping(raw_mapping: dict[Any, Any]) -> dict[pd.Period, float]:
    """Normalize a month->count mapping to ``{Period[M]: float}``.

    Raises a ``ValueError`` on invalid keys/values.
    """
    if not isinstance(raw_mapping, dict):
        raise ValueError("Diner-meal mapping must be a dictionary object.")

    normalized: dict[pd.Period, float] = {}
    for key, value in raw_mapping.items():
        period_key = _to_month_period(key, context="diner-meal mapping")

        try:
            normalized[period_key] = float(value)
        except Exception as exc:
            raise ValueError(f"Invalid diner-meal count for month {key!r}: {value!r}") from exc

    if not normalized:
        raise ValueError("Diner-meal mapping is empty after normalization.")

    return normalized


def load_diner_meal_mapping_from_json(
    diner_meal_file: str | Path | None,
) -> dict[pd.Period, float]:
    """Load and normalize diner-meal mapping from a JSON file."""
    if diner_meal_file is None:
        raise ValueError("diner_meal_file is required when diner_meal_mapping is not provided.")

    dm_path = Path(diner_meal_file).resolve()
    if not dm_path.exists():
        raise FileNotFoundError(f"Diner-meal JSON not found: {dm_path}")

    with open(dm_path) as f:
        raw = json.load(f)

    return normalize_diner_meal_mapping(raw)


def ensure_month_year_column(
    df: pd.DataFrame,
    date_col: str = "date",
    month_col: str = "month_year",
) -> pd.DataFrame:
    """Ensure ``month_col`` exists and is ``Period[M]``.

    Existing values are parsed to period, preserving missingness when parsing fails.
    """
    if date_col not in df.columns and month_col not in df.columns:
        raise ValueError(
            f"Cannot create '{month_col}' without '{date_col}'. Both columns are missing."
        )

    out = df.copy()
    if month_col not in out.columns:
        if date_col not in out.columns:
            raise ValueError(f"Cannot create '{month_col}' because '{date_col}' does not exist.")
        out[month_col] = pd.to_datetime(out[date_col], errors="coerce").dt.to_period("M")
    else:
        out[month_col] = out[month_col].map(
            lambda value: pd.Period(str(value), freq="M") if pd.notna(value) else pd.NA
        )

    return out


def compute_month_alignment(
    df_months: Iterable[Any],
    mapping_months: Iterable[Any],
) -> dict[str, list[pd.Period]]:
    """Compare data months against diner-meal mapping months."""
    data_periods = {
        _to_month_period(month, context="data") for month in df_months if pd.notna(month)
    }
    mapping_periods = {
        _to_month_period(month, context="diner-meal mapping")
        for month in mapping_months
        if pd.notna(month)
    }

    missing_in_mapping = sorted(data_periods - mapping_periods, key=str)
    missing_in_data = sorted(mapping_periods - data_periods, key=str)

    return {
        "missing_in_mapping": missing_in_mapping,
        "missing_in_data": missing_in_data,
    }


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


def divide_by_diner_meals(
    series: pd.Series,
    diner_meal_mapping: dict[Any, Any],
    *,
    strict: bool = True,
) -> tuple[pd.Series, list[pd.Period], list[pd.Period]]:
    """Divide a monthly series by diner-meal mapping with explicit checks.

    Returns tuple ``(result_series, missing_months, invalid_denominator_months)``.
    """
    mapping = normalize_diner_meal_mapping(dict(diner_meal_mapping))
    denominator = pd.Series(mapping).sort_index()

    aligned_index = pd.Index(
        [pd.Period(str(month), freq="M") if pd.notna(month) else month for month in series.index]
    )
    denominator_aligned = denominator.reindex(aligned_index)
    numerators_aligned = pd.Series(series.values, index=aligned_index)

    missing_months = [
        _to_month_period(month, context="series")
        for month in aligned_index[denominator_aligned.isna()]
        if pd.notna(month)
    ]
    invalid_denominators = [
        _to_month_period(month, context="series")
        for month in aligned_index[(denominator_aligned <= 0).fillna(False)]
        if pd.notna(month)
    ]

    if strict and (missing_months or invalid_denominators):
        bits: list[str] = []
        if missing_months:
            bits.append(
                f"missing months in diner_meal_mapping: {sorted(set(missing_months), key=str)}"
            )
        if invalid_denominators:
            bits.append(
                "non-positive diner-meal counts for months: "
                f"{sorted(set(invalid_denominators), key=str)}"
            )
        raise ValueError("Cannot compute per-diner metrics: " + "; ".join(bits))

    result = numerators_aligned / denominator_aligned
    result.index = series.index

    return (
        result,
        sorted(set(missing_months), key=str),
        sorted(set(invalid_denominators), key=str),
    )
