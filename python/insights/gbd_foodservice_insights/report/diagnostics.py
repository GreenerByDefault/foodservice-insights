"""Data quality checks, validation, and anomaly detection for food reports."""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from datetime import date, datetime, timedelta
from functools import lru_cache
from itertools import combinations, pairwise
from pathlib import Path
from typing import Any, Literal, Protocol, cast, overload

import numpy as np
import pandas as pd
import yaml
from Levenshtein import distance

from gbd_foodservice_insights import PACKAGE_DIR
from gbd_foodservice_insights.categories import get_GBD_categories, get_meat_categories
from gbd_foodservice_insights.report.quality import make_finding
from gbd_foodservice_insights.report.schema import (
    metric_for_mode,
    normalize_report_mode,
    required_columns_for_mode,
)
from gbd_foodservice_insights.report.utils import compute_month_alignment, ensure_month_year_column

logger = logging.getLogger(__name__)

DEFAULT_DIAGNOSTIC_THRESHOLDS_PATH = PACKAGE_DIR / "data_files" / "diagnostic_thresholds.yaml"
DIAGNOSTIC_THRESHOLDS_PATH = DEFAULT_DIAGNOSTIC_THRESHOLDS_PATH
MISSING_TEXT_TOKENS = {"", "na", "n/a", "nan", "none", "null", "nat", "missing"}


def _load_threshold_mapping(path: Path) -> dict[str, Any]:
    """Load one YAML threshold mapping and validate its top-level shape."""
    if not path.exists():
        raise FileNotFoundError(f"Diagnostic thresholds file not found: {path}")

    with open(path) as f:
        loaded = yaml.safe_load(f) or {}

    if not isinstance(loaded, dict):
        raise ValueError(f"{path.name} must contain a top-level mapping of diagnostic names.")

    return cast(dict[str, Any], loaded)


def _merge_threshold_mappings(
    base_thresholds: dict[str, Any],
    override_thresholds: dict[str, Any],
) -> dict[str, Any]:
    """Merge per-diagnostic threshold overrides on top of the repo defaults."""
    merged = dict(base_thresholds)
    for diagnostic_name, override_value in override_thresholds.items():
        base_value = merged.get(diagnostic_name)
        if isinstance(base_value, dict) and isinstance(override_value, dict):
            merged[diagnostic_name] = {**base_value, **override_value}
        else:
            merged[diagnostic_name] = override_value
    return merged


def _threshold_cache_key(path: Path) -> tuple[str, int]:
    """Build a cache key that changes when the thresholds file path or contents change."""
    resolved_path = path.resolve()
    return str(resolved_path), resolved_path.stat().st_mtime_ns


@lru_cache(maxsize=8)
def _load_diagnostic_thresholds_cached(
    default_path_str: str,
    current_path_str: str,
    default_mtime_ns: int,
    current_mtime_ns: int,
) -> dict[str, Any]:
    """Cache threshold loading by file path and last-modified time."""
    default_path = Path(default_path_str)
    current_path = Path(current_path_str)

    # The mtime values are part of the cache key and intentionally unused here.
    del default_mtime_ns, current_mtime_ns

    base_thresholds = _load_threshold_mapping(default_path)
    if current_path == default_path:
        return base_thresholds

    override_thresholds = _load_threshold_mapping(current_path)
    return _merge_threshold_mappings(base_thresholds, override_thresholds)


def _load_diagnostic_thresholds() -> dict[str, Any]:
    """Load diagnostic thresholds from the checked-in YAML plus any override file."""
    default_path_key, default_mtime_ns = _threshold_cache_key(DEFAULT_DIAGNOSTIC_THRESHOLDS_PATH)
    current_path_key, current_mtime_ns = _threshold_cache_key(DIAGNOSTIC_THRESHOLDS_PATH)
    return _load_diagnostic_thresholds_cached(
        default_path_key,
        current_path_key,
        default_mtime_ns,
        current_mtime_ns,
    )


class _ThresholdLoader(Protocol):
    """Callable threshold loader with the cache controls exposed to callers."""

    cache_clear: Callable[[], None]
    cache_info: Callable[[], Any]

    def __call__(self) -> dict[str, Any]: ...


load_diagnostic_thresholds = cast(_ThresholdLoader, _load_diagnostic_thresholds)
load_diagnostic_thresholds.cache_clear = _load_diagnostic_thresholds_cached.cache_clear
load_diagnostic_thresholds.cache_info = _load_diagnostic_thresholds_cached.cache_info


def get_diagnostic_threshold(
    diagnostic_name: str,
    threshold_name: str,
) -> float:
    """Read one threshold from YAML and fail loudly if config is incomplete."""
    thresholds = load_diagnostic_thresholds()
    diagnostic_thresholds = thresholds.get(diagnostic_name)
    if not isinstance(diagnostic_thresholds, dict):
        raise KeyError(
            f"Thresholds for diagnostic '{diagnostic_name}' must be defined as a mapping in "
            f"{DIAGNOSTIC_THRESHOLDS_PATH.name}."
        )

    if threshold_name not in diagnostic_thresholds:
        raise KeyError(
            f"Missing threshold '{diagnostic_name}.{threshold_name}' in "
            f"{DIAGNOSTIC_THRESHOLDS_PATH.name}."
        )

    value = diagnostic_thresholds[threshold_name]
    try:
        return float(value)
    except (TypeError, ValueError) as err:
        raise ValueError(
            f"Threshold '{diagnostic_name}.{threshold_name}' must be numeric; got {value!r}."
        ) from err


def resolve_diagnostic_threshold(
    diagnostic_name: str,
    threshold_name: str,
    override: float | None,
) -> float:
    """Return an explicit override when provided, otherwise read from YAML."""
    if override is not None:
        return float(override)
    return get_diagnostic_threshold(diagnostic_name, threshold_name)


def clean_column_names(df: pd.DataFrame) -> pd.DataFrame:
    """Clean the column names of a pandas DataFrame.

    Strips whitespace, lowercases, and replaces spaces with underscores.
    """
    if df.columns.empty:
        return df
    print(f"columns before:  {list(df.columns)}")
    df.columns = df.columns.str.strip().str.lower().str.replace(" ", "_")
    print(f"columns after:   {list(df.columns)}\n\n")
    return df


def _duplicate_row_status(duplicate_share: float) -> str:
    """Map duplicate-row share to a finding severity for row-level QA checks."""
    error_threshold = get_diagnostic_threshold(
        "exact_duplicate_rows",
        "error_share_threshold",
    )
    warning_threshold = get_diagnostic_threshold(
        "exact_duplicate_rows",
        "warning_share_threshold",
    )
    if duplicate_share > error_threshold:
        return "error"
    if duplicate_share > warning_threshold:
        return "warning"
    return "success"


def _dates_appear_month_bucketed(date_series: pd.Series) -> bool:
    """Whether dates appear to encode month/year buckets rather than transaction dates."""
    parsed_dates = pd.to_datetime(date_series, errors="coerce")
    non_missing_dates = parsed_dates.dropna()
    if non_missing_dates.empty:
        return False

    if not non_missing_dates.dt.normalize().eq(non_missing_dates).all():
        return False

    if not non_missing_dates.dt.day.eq(1).all():
        return False

    unique_dates = int(non_missing_dates.nunique())
    unique_months = int(non_missing_dates.dt.to_period("M").nunique())
    return unique_dates == unique_months


def _dates_support_within_month_gap_detection(date_series: pd.Series) -> bool:
    """Whether dates contain enough day-level variation to support missing-weeks QA.

    This exists so the missing-weeks diagnostic does not misread month-only data
    as daily transactions. We only run the check when at least one month has
    more than one distinct transaction date after parsing and normalization.
    """
    parsed_dates = pd.to_datetime(date_series, errors="coerce")
    non_missing_dates = parsed_dates.dropna()
    if non_missing_dates.empty:
        return False

    normalized_dates = non_missing_dates.dt.normalize()
    if _dates_appear_month_bucketed(normalized_dates):
        return False

    unique_dates_per_month = normalized_dates.groupby(normalized_dates.dt.to_period("M")).nunique()
    if unique_dates_per_month.empty:
        return False

    return bool(unique_dates_per_month.gt(1).any())


def detect_exact_duplicate_rows(
    df: pd.DataFrame,
    metric_total: str,
    *,
    sample_limit: int = 5,
) -> tuple[list[dict[str, Any]], pd.DataFrame]:
    """Flag exact duplicate line items before duplicated rows inflate report totals.

    This diagnostic exists because duplicated transactions usually come from an
    export, merge, or pipeline issue rather than real purchasing behaviour. The
    report needs to surface them clearly before totals, emissions, and category
    summaries are overstated.
    """
    required_key_columns = ["date", "product", "category", metric_total]
    key_columns = [*required_key_columns]
    if "quantity" in df.columns:
        key_columns.append("quantity")

    missing_columns = [column for column in required_key_columns if column not in df.columns]
    if missing_columns:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="exact_duplicate_rows",
                    status="info",
                    message=(
                        "Could not check for exact duplicate rows because these columns are "
                        f"missing: {missing_columns}"
                    ),
                    metadata={"missing_columns": missing_columns},
                )
            ],
            pd.DataFrame(),
        )

    if df.empty:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="exact_duplicate_rows",
                    status="success",
                    message="No duplicate rows found.",
                    count=0,
                    metadata={
                        "duplicate_row_share": 0.0,
                        "duplicate_row_count": 0,
                        "duplicate_group_count": 0,
                        "key_columns": key_columns,
                    },
                )
            ],
            pd.DataFrame(columns=[*key_columns, "duplicate_group_size"]),
        )

    duplicate_mask = df.duplicated(subset=key_columns, keep=False)
    duplicate_rows = df.loc[duplicate_mask].copy()

    if duplicate_rows.empty:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="exact_duplicate_rows",
                    status="success",
                    message="No duplicate rows found.",
                    count=0,
                    metadata={
                        "duplicate_row_share": 0.0,
                        "duplicate_row_count": 0,
                        "duplicate_group_count": 0,
                        "key_columns": key_columns,
                    },
                )
            ],
            pd.DataFrame(columns=[*df.columns, "duplicate_group_size"]),
        )

    duplicate_group_sizes = duplicate_rows.groupby(key_columns, dropna=False).size()
    duplicate_rows = duplicate_rows.merge(
        duplicate_group_sizes.rename("duplicate_group_size").reset_index(),
        on=key_columns,
        how="left",
    )
    duplicate_rows = duplicate_rows.sort_values(
        ["duplicate_group_size", *key_columns],
        ascending=[False, *([True] * len(key_columns))],
    )

    duplicate_row_count = len(duplicate_rows)
    duplicate_group_count = int(duplicate_group_sizes.shape[0])
    duplicate_share = duplicate_row_count / len(df)
    status = _duplicate_row_status(duplicate_share)
    month_bucketed_dates = "date" in df.columns and _dates_appear_month_bucketed(df["date"])
    if month_bucketed_dates and status == "error":
        status = "warning"
    warning_threshold = get_diagnostic_threshold(
        "exact_duplicate_rows",
        "warning_share_threshold",
    )
    error_threshold = get_diagnostic_threshold(
        "exact_duplicate_rows",
        "error_share_threshold",
    )

    sample_rows = (
        duplicate_rows.loc[:, [*key_columns, "duplicate_group_size"]]
        .head(sample_limit)
        .replace({pd.NaT: None, pd.NA: None})
        .to_dict("records")
    )
    sample_values = [
        (
            f"{row.get('product', 'Unknown product')} on {row.get('date')} appears "
            f"{row.get('duplicate_group_size')} times."
        )
        for row in sample_rows
    ]

    if month_bucketed_dates:
        message_tail = (
            "The input dates appear to be month-level placeholders rather than transaction "
            "dates, so repeated purchases within a month can look identical. Treat this as a "
            "warning to review rather than proof of a duplicate-row bug."
        )
    else:
        severity_phrase = (
            "serious duplicate rows issue" if status == "error" else "duplicate rows issue"
        )
        message_tail = (
            f"This suggests a {severity_phrase} that could overstate totals and emissions."
        )
    findings = [
        make_finding(
            stage="diagnostics",
            category="exact_duplicate_rows",
            status=status,
            message=(
                f"Found {duplicate_row_count} rows that are exact duplicates across the key "
                f"report fields ({duplicate_share:.1%} of all rows) across "
                f"{duplicate_group_count} duplicated line item patterns. {message_tail}"
            ),
            count=duplicate_row_count,
            sample_values=sample_values,
            metadata={
                "duplicate_row_share": duplicate_share,
                "duplicate_row_count": duplicate_row_count,
                "duplicate_group_count": duplicate_group_count,
                "month_bucketed_dates": month_bucketed_dates,
                "key_columns": key_columns,
                "warning_share_threshold": warning_threshold,
                "error_share_threshold": error_threshold,
                "sample_rows": sample_rows,
            },
        )
    ]
    return findings, duplicate_rows


def summarise_numeric_columns(
    df: pd.DataFrame,
    numeric_columns: list[str] | None = None,
) -> pd.DataFrame:
    """Summarize specified numeric columns in a DataFrame.

    For each numeric column, calculates mean, median, max, min, counts of
    negative values, zeros, and NaN values.

    Args:
        df: The input DataFrame.
        numeric_columns: Columns to summarize. If ``None``, all numeric columns
            (excluding ``'page'``) are used.

    Returns:
        Summary DataFrame with one row per numeric column.
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


@overload
def detect_unusual_sales(
    df: pd.DataFrame,
    summary_col: str,
    product_name_col: str,
    threshold: float | None = None,
    *,
    category_col: str = "category",
    min_category_rows: int | None = None,
    warning_share_threshold: float | None = None,
    extreme_ratio_threshold: float | None = None,
    zero_mad_ratio_threshold: float | None = None,
    small_category_ratio_threshold: float | None = None,
    sample_limit: int = 5,
    return_details: Literal[False] = False,
) -> list[str]: ...


@overload
def detect_unusual_sales(
    df: pd.DataFrame,
    summary_col: str,
    product_name_col: str,
    threshold: float | None = None,
    *,
    category_col: str = "category",
    min_category_rows: int | None = None,
    warning_share_threshold: float | None = None,
    extreme_ratio_threshold: float | None = None,
    zero_mad_ratio_threshold: float | None = None,
    small_category_ratio_threshold: float | None = None,
    sample_limit: int = 5,
    return_details: Literal[True],
) -> tuple[list[dict[str, Any]], pd.DataFrame]: ...


@overload
def detect_unusual_sales(
    df: pd.DataFrame,
    summary_col: str,
    product_name_col: str,
    threshold: float | None = None,
    *,
    category_col: str = "category",
    min_category_rows: int | None = None,
    warning_share_threshold: float | None = None,
    extreme_ratio_threshold: float | None = None,
    zero_mad_ratio_threshold: float | None = None,
    small_category_ratio_threshold: float | None = None,
    sample_limit: int = 5,
    return_details: bool,
) -> list[str] | tuple[list[dict[str, Any]], pd.DataFrame]: ...


def detect_unusual_sales(
    df: pd.DataFrame,
    summary_col: str,
    product_name_col: str,
    threshold: float | None = None,
    *,
    category_col: str = "category",
    min_category_rows: int | None = None,
    warning_share_threshold: float | None = None,
    extreme_ratio_threshold: float | None = None,
    zero_mad_ratio_threshold: float | None = None,
    small_category_ratio_threshold: float | None = None,
    sample_limit: int = 5,
    return_details: bool = False,
) -> list[str] | tuple[list[dict[str, Any]], pd.DataFrame]:
    """Flag unusually large line items before bad rows distort totals and trends.

    This exists to catch row-level values that are implausibly high for their
    category and are more likely to be entry, unit, or OCR mistakes than real
    purchasing behaviour. Category-level medians and MAD keep the baseline
    robust to skewed data, while ratio-based fallbacks still catch obvious
    extremes in categories with very low spread.
    """
    threshold = resolve_diagnostic_threshold(
        "outlier_line_items",
        "mad_threshold",
        threshold,
    )
    min_category_rows = max(
        int(
            resolve_diagnostic_threshold(
                "outlier_line_items",
                "min_category_rows",
                float(min_category_rows) if min_category_rows is not None else None,
            )
        ),
        1,
    )
    warning_share_threshold = resolve_diagnostic_threshold(
        "outlier_line_items",
        "warning_share_threshold",
        warning_share_threshold,
    )
    extreme_ratio_threshold = resolve_diagnostic_threshold(
        "outlier_line_items",
        "extreme_ratio_threshold",
        extreme_ratio_threshold,
    )
    zero_mad_ratio_threshold = resolve_diagnostic_threshold(
        "outlier_line_items",
        "zero_mad_ratio_threshold",
        zero_mad_ratio_threshold,
    )
    small_category_ratio_threshold = resolve_diagnostic_threshold(
        "outlier_line_items",
        "small_category_ratio_threshold",
        small_category_ratio_threshold,
    )
    legacy_median_floor = get_diagnostic_threshold(
        "outlier_line_items",
        "legacy_median_floor",
    )
    legacy_absolute_threshold = get_diagnostic_threshold(
        "outlier_line_items",
        "legacy_absolute_threshold_if_below_floor",
    )

    legacy_required_columns = [summary_col, product_name_col]
    missing_legacy_columns = [
        column for column in legacy_required_columns if column not in df.columns
    ]
    if missing_legacy_columns:
        raise KeyError(
            f"Missing required columns for unusual sales check: {missing_legacy_columns}"
        )

    if category_col not in df.columns:
        if return_details:
            raise KeyError(f"Missing required columns for unusual sales check: ['{category_col}']")

        print(
            f"Checking for products that have any rows where {summary_col} is {threshold}x "
            f"the median (if median > {legacy_median_floor:g}) or greater than "
            f"{legacy_absolute_threshold:g} if median ≤ {legacy_median_floor:g}"
        )
        abnormal_products: list[str] = []

        for product in df[product_name_col].unique():
            product_data = df[df[product_name_col] == product]
            if len(product_data) < 5:
                continue

            median = product_data[summary_col].median()
            if median <= 0:
                raise AssertionError(f"median below 0 for product {product}")

            unusual_threshold = (
                median * threshold if median > legacy_median_floor else legacy_absolute_threshold
            )
            if product_data[summary_col].max() > unusual_threshold:
                abnormal_products.append(product)

        return abnormal_products

    if df.empty:
        if return_details:
            findings = [
                make_finding(
                    stage="diagnostics",
                    category="outlier_line_items",
                    status="success",
                    message="No unusually large line items found.",
                    count=0,
                    metadata={
                        "outlier_row_share": 0.0,
                        "warning_share_threshold": warning_share_threshold,
                        "extreme_ratio_threshold": extreme_ratio_threshold,
                    },
                )
            ]
            return findings, pd.DataFrame()
        return []

    working = df.copy()
    working["_row_index"] = working.index
    working["_metric_value"] = pd.to_numeric(working[summary_col], errors="coerce")

    valid_rows = working[
        working[category_col].notna()
        & working["_metric_value"].notna()
        & (working["_metric_value"] > 0)
    ].copy()

    if valid_rows.empty:
        if return_details:
            findings = [
                make_finding(
                    stage="diagnostics",
                    category="outlier_line_items",
                    status="success",
                    message="No unusually large line items found.",
                    count=0,
                    metadata={
                        "outlier_row_share": 0.0,
                        "warning_share_threshold": warning_share_threshold,
                        "extreme_ratio_threshold": extreme_ratio_threshold,
                    },
                )
            ]
            return findings, pd.DataFrame()
        return []

    grouped = valid_rows.groupby(category_col)["_metric_value"]
    stats = grouped.agg(category_row_count="size", category_median="median").reset_index()
    mad = grouped.apply(
        lambda series: float(np.median(np.abs(series - float(np.median(series)))))
    ).rename("category_mad")
    stats = stats.merge(mad.reset_index(), on=category_col, how="left")

    valid_rows = valid_rows.merge(stats, on=category_col, how="left")
    valid_rows["ratio_to_category_median"] = np.where(
        valid_rows["category_median"] > 0,
        valid_rows["_metric_value"] / valid_rows["category_median"],
        np.nan,
    )
    valid_rows["modified_z_score"] = np.where(
        valid_rows["category_mad"] > 0,
        0.6745
        * (valid_rows["_metric_value"] - valid_rows["category_median"])
        / valid_rows["category_mad"],
        np.nan,
    )

    has_enough_rows = valid_rows["category_row_count"] >= min_category_rows
    above_median = valid_rows["_metric_value"] > valid_rows["category_median"]
    mad_based_flag = (
        has_enough_rows
        & above_median
        & (valid_rows["category_mad"] > 0)
        & (valid_rows["modified_z_score"] >= threshold)
    )
    zero_mad_flag = (
        has_enough_rows
        & above_median
        & (valid_rows["category_mad"] == 0)
        & (valid_rows["ratio_to_category_median"] >= zero_mad_ratio_threshold)
    )
    small_category_flag = (
        ~has_enough_rows
        & above_median
        & (valid_rows["ratio_to_category_median"] >= small_category_ratio_threshold)
        & (
            ((valid_rows["category_mad"] > 0) & (valid_rows["modified_z_score"] >= threshold))
            | (valid_rows["category_mad"] == 0)
        )
    )
    extreme_ratio_flag = above_median & (
        valid_rows["ratio_to_category_median"] >= extreme_ratio_threshold
    )

    valid_rows["flagged_by_mad"] = mad_based_flag
    valid_rows["flagged_by_zero_mad_ratio"] = zero_mad_flag
    valid_rows["flagged_by_small_category_ratio"] = small_category_flag
    valid_rows["flagged_by_extreme_ratio"] = extreme_ratio_flag
    valid_rows["is_outlier"] = (
        mad_based_flag | zero_mad_flag | small_category_flag | extreme_ratio_flag
    )

    flagged_rows = valid_rows.loc[valid_rows["is_outlier"]].copy()
    if flagged_rows.empty:
        if return_details:
            findings = [
                make_finding(
                    stage="diagnostics",
                    category="outlier_line_items",
                    status="success",
                    message="No unusually large line items found.",
                    count=0,
                    metadata={
                        "outlier_row_share": 0.0,
                        "warning_share_threshold": warning_share_threshold,
                        "extreme_ratio_threshold": extreme_ratio_threshold,
                    },
                )
            ]
            return findings, pd.DataFrame()
        return []

    flagged_rows["flag_reason"] = flagged_rows.apply(
        lambda row: ", ".join(
            reason
            for reason, is_active in [
                ("MAD threshold", bool(row["flagged_by_mad"])),
                ("zero-MAD ratio fallback", bool(row["flagged_by_zero_mad_ratio"])),
                (
                    "small-category severe ratio fallback",
                    bool(row["flagged_by_small_category_ratio"]),
                ),
                ("extreme median ratio", bool(row["flagged_by_extreme_ratio"])),
            ]
            if is_active
        ),
        axis=1,
    )
    flagged_rows = flagged_rows.sort_values(
        ["ratio_to_category_median", "_metric_value"],
        ascending=[False, False],
    )

    abnormal_products = sorted(
        flagged_rows[product_name_col].dropna().astype(str).unique().tolist()
    )
    if not return_details:
        return abnormal_products

    outlier_row_count = len(flagged_rows)
    outlier_row_share = outlier_row_count / len(df)
    has_severe_ratio_flag = bool(
        flagged_rows["flagged_by_extreme_ratio"].any()
        or flagged_rows["flagged_by_small_category_ratio"].any()
    )
    status = (
        "warning"
        if (outlier_row_share >= warning_share_threshold or has_severe_ratio_flag)
        else "info"
    )

    top_row = flagged_rows.iloc[0]
    sample_values = ["Affected products: " + ", ".join(abnormal_products)]
    sample_values.extend(
        [
            (
                f"{row[product_name_col]} in {row[category_col]} has "
                f"{row['_metric_value']:.2f}, which is "
                f"{row['ratio_to_category_median']:.1f}x the category median of "
                f"{row['category_median']:.2f}."
            )
            for _, row in flagged_rows.head(sample_limit).iterrows()
        ]
    )

    findings = [
        make_finding(
            stage="diagnostics",
            category="outlier_line_items",
            status=status,
            message=(
                f"Found {outlier_row_count} unusually large line items "
                f"({outlier_row_share:.2%} of all rows). The largest was "
                f"{top_row[product_name_col]} in {top_row[category_col]} at "
                f"{top_row['_metric_value']:.2f}, which is "
                f"{top_row['ratio_to_category_median']:.1f}x that category's median of "
                f"{top_row['category_median']:.2f}. These rows may need review for unit, "
                "entry, or OCR mistakes."
            ),
            column=summary_col,
            count=outlier_row_count,
            sample_values=sample_values,
            metadata={
                "outlier_row_share": outlier_row_share,
                "warning_share_threshold": warning_share_threshold,
                "extreme_ratio_threshold": extreme_ratio_threshold,
                "zero_mad_ratio_threshold": zero_mad_ratio_threshold,
                "small_category_ratio_threshold": small_category_ratio_threshold,
                "mad_threshold": threshold,
                "min_category_rows": min_category_rows,
                "legacy_median_floor": legacy_median_floor,
                "legacy_absolute_threshold_if_below_floor": legacy_absolute_threshold,
                "sample_rows": flagged_rows.head(sample_limit)
                .replace({pd.NaT: None, pd.NA: None})
                .to_dict("records"),
            },
        )
    ]

    export_columns = [
        "_row_index",
        "date",
        product_name_col,
        category_col,
        summary_col,
        "category_row_count",
        "category_median",
        "category_mad",
        "ratio_to_category_median",
        "modified_z_score",
        "flag_reason",
        "flagged_by_mad",
        "flagged_by_zero_mad_ratio",
        "flagged_by_small_category_ratio",
        "flagged_by_extreme_ratio",
    ]
    available_export_columns = [
        column for column in export_columns if column in flagged_rows.columns
    ]
    export_df = flagged_rows.loc[:, available_export_columns].rename(
        columns={"_row_index": "row_index"}
    )
    return findings, export_df


def check_per_product_weight_bounds(
    df: pd.DataFrame,
    metric_col: str,
    low: float | None = None,
    high: float | None = None,
    sample_limit: int = 20,
) -> tuple[list[dict[str, Any]], pd.DataFrame]:
    """Flag line items with weights outside the hard bounds used for unit-error QA.

    This exists to catch near-certain unit mistakes that are easy to explain and
    review. Unlike the category-relative outlier check, these absolute limits do
    not depend on distribution shape and are intended for obviously implausible
    single-row transaction weights.
    """
    threshold_group = "per_product_weight_bounds"
    subject_label = "per-product weights"
    unit_label = "kg"
    if metric_col == "servings total":
        threshold_group = "per_product_serving_bounds"
        subject_label = "per-product serving counts"
        unit_label = "servings"

    low = resolve_diagnostic_threshold(threshold_group, "low", low)
    high = resolve_diagnostic_threshold(threshold_group, "high", high)
    if low > high:
        raise ValueError(f"Per-product weight bounds must satisfy low <= high; got {low} > {high}.")

    required_columns = [metric_col, "product"]
    missing_columns = [column for column in required_columns if column not in df.columns]
    if missing_columns:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="per_product_weight_bounds",
                    status="info",
                    message=(
                        f"Could not check {subject_label} because these columns are missing: "
                        f"{missing_columns}"
                    ),
                    metadata={"missing_columns": missing_columns},
                )
            ],
            pd.DataFrame(),
        )

    if df.empty:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="per_product_weight_bounds",
                    status="success",
                    message=f"No {subject_label} issues found.",
                    count=0,
                    metadata={"low": low, "high": high, "flagged_row_count": 0},
                )
            ],
            pd.DataFrame(columns=["row_index", "product", metric_col, "breached_bound"]),
        )

    working = df.copy()
    working["_row_index"] = working.index
    working["_metric_value"] = pd.to_numeric(working[metric_col], errors="coerce")

    flagged_rows = working.loc[
        working["_metric_value"].notna()
        & ((working["_metric_value"] < low) | (working["_metric_value"] > high))
    ].copy()

    if flagged_rows.empty:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="per_product_weight_bounds",
                    status="success",
                    message=f"No {subject_label} issues found.",
                    count=0,
                    metadata={"low": low, "high": high, "flagged_row_count": 0},
                )
            ],
            pd.DataFrame(columns=["row_index", "product", metric_col, "breached_bound"]),
        )

    flagged_rows["breached_bound"] = np.where(
        flagged_rows["_metric_value"] < low,
        "lower",
        "upper",
    )
    flagged_rows["breached_threshold"] = np.where(
        flagged_rows["breached_bound"] == "lower",
        low,
        high,
    )
    flagged_rows = flagged_rows.sort_values(
        ["breached_bound", "_metric_value", "_row_index"],
        ascending=[True, True, True],
    )

    sample_values = [
        (
            f"Row {int(row['_row_index'])}: {row['product']} has "
            f"{row['_metric_value']:.4f} {unit_label}, which is "
            f"{'below' if row['breached_bound'] == 'lower' else 'above'} the "
            f"{row['breached_threshold']:.3f} {unit_label} "
            f"{'lower' if row['breached_bound'] == 'lower' else 'upper'} bound."
        )
        for _, row in flagged_rows.head(sample_limit).iterrows()
    ]
    top_row = flagged_rows.iloc[0]
    direction = "below" if top_row["breached_bound"] == "lower" else "above"
    bound_label = "lower" if top_row["breached_bound"] == "lower" else "upper"

    findings = [
        make_finding(
            stage="diagnostics",
            category="per_product_weight_bounds",
            status="warning",
            message=(
                f"Found {len(flagged_rows)} rows with {subject_label} outside the hard review "
                f"bounds of {low:.3f} to {high:.3f} {unit_label}. The first flagged row was "
                f"{top_row['product']} at row {int(top_row['_row_index'])} with "
                f"{top_row['_metric_value']:.4f} {unit_label}, which is {direction} the "
                f"{bound_label} bound."
            ),
            column=metric_col,
            count=len(flagged_rows),
            sample_values=sample_values,
            metadata={
                "low": low,
                "high": high,
                "unit_label": unit_label,
                "flagged_row_count": len(flagged_rows),
                "sample_rows": flagged_rows.head(sample_limit)
                .replace({pd.NaT: None, pd.NA: None})
                .to_dict("records"),
            },
        )
    ]

    export_columns = [
        "_row_index",
        "date",
        "product",
        "category",
        metric_col,
        "_metric_value",
        "breached_bound",
        "breached_threshold",
    ]
    available_export_columns = [
        column for column in export_columns if column in flagged_rows.columns
    ]
    export_df = flagged_rows.loc[:, available_export_columns].rename(
        columns={
            "_row_index": "row_index",
            "_metric_value": "metric_value",
        }
    )
    return findings, export_df


def find_close_product_pairs(
    df: pd.DataFrame,
    product_column: str,
    *,
    metric_column: str | None = None,
    max_levenshtein_distance: int | None = None,
) -> pd.DataFrame:
    """Identify close product-name pairs so likely name splits can be reviewed.

    This exists because OCR mistakes and minor typing differences can split one
    real product into multiple names, fragmenting totals and weakening the
    report's category and trend summaries.
    """
    if product_column not in df.columns:
        return pd.DataFrame()

    max_levenshtein_distance = max(
        int(
            resolve_diagnostic_threshold(
                "near_duplicate_product_names",
                "max_levenshtein_distance",
                float(max_levenshtein_distance) if max_levenshtein_distance is not None else None,
            )
        ),
        0,
    )

    product_counts: pd.Series = df[product_column].value_counts()
    products: list[str] = product_counts.index.tolist()
    metric_by_product: pd.Series | None = None
    total_metric = 0.0
    if metric_column is not None and metric_column in df.columns:
        metric_values = pd.to_numeric(df[metric_column], errors="coerce").fillna(0.0)
        metric_by_product = metric_values.groupby(df[product_column]).sum(min_count=1)
        total_metric = float(metric_values.sum())

    close_pairs: list[dict[str, Any]] = []
    for prod1, prod2 in combinations(products, 2):
        pair_distance = distance(str(prod1), str(prod2))
        if pair_distance <= max_levenshtein_distance:
            sorted_pair = sorted([str(prod1), str(prod2)])
            pair_record: dict[str, Any] = {
                "Product 1": sorted_pair[0],
                "Product 2": sorted_pair[1],
                "Product 1 Row Count": int(product_counts[sorted_pair[0]]),
                "Product 2 Row Count": int(product_counts[sorted_pair[1]]),
                "Levenshtein Distance": int(pair_distance),
            }
            if metric_by_product is not None:
                product_1_metric = float(metric_by_product.get(sorted_pair[0], 0.0))
                product_2_metric = float(metric_by_product.get(sorted_pair[1], 0.0))
                combined_metric = product_1_metric + product_2_metric
                pair_record.update(
                    {
                        "Product 1 Metric Total": product_1_metric,
                        "Product 2 Metric Total": product_2_metric,
                        "Combined Metric Total": combined_metric,
                        "Combined Metric Share": (
                            combined_metric / total_metric if total_metric > 0 else 0.0
                        ),
                    }
                )
            close_pairs.append(pair_record)

    close_pairs_df = pd.DataFrame(close_pairs)
    if close_pairs_df.empty:
        return close_pairs_df

    close_pairs_df["distance_between_counts"] = np.abs(
        close_pairs_df["Product 1 Row Count"] - close_pairs_df["Product 2 Row Count"]
    )
    sort_columns = ["distance_between_counts"]
    ascending = [False]
    if "Combined Metric Share" in close_pairs_df.columns:
        sort_columns = ["Combined Metric Share", "distance_between_counts"]
        ascending = [False, False]
    return close_pairs_df.sort_values(sort_columns, ascending=ascending).reset_index(drop=True)


def detect_near_duplicate_product_names(
    df: pd.DataFrame,
    metric_total: str,
    *,
    product_column: str = "product",
    pdf_extracted: bool | None = None,
    sample_limit: int = 5,
) -> tuple[list[dict[str, Any]], pd.DataFrame]:
    """Surface materially important near-duplicate product names before totals fragment.

    This exists because OCR and small typing mistakes can split one product into
    multiple names. Weighting candidate pairs by their share of the main report
    metric keeps the diagnostic focused on issues that could meaningfully change
    the story a catering manager sees in the report.
    """
    if product_column not in df.columns:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="near_duplicate_product_names",
                    status="info",
                    message=(
                        "Could not check for near-duplicate product names because the "
                        "product column is missing."
                    ),
                    metadata={"missing_columns": [product_column]},
                )
            ],
            pd.DataFrame(),
        )

    if metric_total not in df.columns:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="near_duplicate_product_names",
                    status="info",
                    message=(
                        "Could not check for near-duplicate product names because "
                        f"'{metric_total}' is missing."
                    ),
                    metadata={"missing_columns": [metric_total]},
                )
            ],
            pd.DataFrame(),
        )

    warning_share_threshold = get_diagnostic_threshold(
        "near_duplicate_product_names",
        "warning_share_threshold",
    )
    max_levenshtein_distance = int(
        get_diagnostic_threshold(
            "near_duplicate_product_names",
            "max_levenshtein_distance",
        )
    )

    close_pairs = find_close_product_pairs(
        df,
        product_column,
        metric_column=metric_total,
        max_levenshtein_distance=max_levenshtein_distance,
    )
    if close_pairs.empty:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="near_duplicate_product_names",
                    status="success",
                    message="No near-duplicate product names found.",
                    count=0,
                    metadata={
                        "pdf_extracted": pdf_extracted,
                        "material_pair_count": 0,
                        "max_levenshtein_distance": max_levenshtein_distance,
                        "warning_share_threshold": warning_share_threshold,
                    },
                )
            ],
            close_pairs,
        )

    material_pairs = close_pairs[
        close_pairs["Combined Metric Share"] >= warning_share_threshold
    ].copy()
    material_pair_count = len(material_pairs)

    if material_pair_count == 0:
        status = "info"
        message = (
            f"Found {len(close_pairs)} near-duplicate product-name pairs, but none account "
            f"for {warning_share_threshold:.0%} or more of the total report volume."
        )
        surfaced_pairs = close_pairs.head(sample_limit)
    else:
        status = "warning" if pdf_extracted else "info"
        source_phrase = "PDF-extracted data" if pdf_extracted else "tabular data"
        message = (
            f"Found {material_pair_count} near-duplicate product-name pairs in "
            f"{source_phrase} that each account for at least "
            f"{warning_share_threshold:.0%} of the total report volume. These names may "
            "need to be combined so the same product is not split across multiple labels."
        )
        surfaced_pairs = material_pairs.head(sample_limit)

    sample_values = [
        (
            f"{row['Product 1']} / {row['Product 2']} together make up "
            f"{row['Combined Metric Total']:.2f} "
            f"({row['Combined Metric Share']:.1%}) of the total."
        )
        for _, row in surfaced_pairs.iterrows()
    ]

    findings = [
        make_finding(
            stage="diagnostics",
            category="near_duplicate_product_names",
            status=status,
            message=message,
            count=material_pair_count,
            sample_values=sample_values,
            metadata={
                "pdf_extracted": pdf_extracted,
                "max_levenshtein_distance": max_levenshtein_distance,
                "warning_share_threshold": warning_share_threshold,
                "candidate_pair_count": len(close_pairs),
                "material_pair_count": material_pair_count,
                "sample_pairs": surfaced_pairs.replace({pd.NaT: None, pd.NA: None}).to_dict(
                    "records"
                ),
            },
        )
    ]
    return findings, close_pairs


def detect_month_over_month_total_volatility(
    df: pd.DataFrame,
    metric_total: str,
    *,
    month_col: str = "month_year",
    date_col: str = "date",
    sample_limit: int = 6,
) -> list[dict[str, Any]]:
    """Flag sudden monthly total swings before users trust a misleading trend.

    This exists because large month-to-month changes are often caused by
    missing uploads, partial months, or duplicated data rather than a real
    operational shift. Surfacing those jumps gives catering managers a simple
    continuity check before they read the rest of the report.
    """
    if metric_total not in df.columns:
        return [
            make_finding(
                stage="diagnostics",
                category="month_over_month_total_volatility",
                status="info",
                message=(
                    "Could not check month-to-month total volatility because "
                    f"'{metric_total}' is missing."
                ),
                metadata={"missing_columns": [metric_total]},
            )
        ]

    try:
        monthly_df = ensure_month_year_column(
            df[[*df.columns]].copy(), date_col=date_col, month_col=month_col
        )
    except ValueError as exc:
        return [
            make_finding(
                stage="diagnostics",
                category="month_over_month_total_volatility",
                status="info",
                message=f"Could not check month-to-month total volatility: {exc}",
                metadata={"missing_columns": [date_col, month_col]},
            )
        ]

    monthly_totals = (
        monthly_df.dropna(subset=[month_col])
        .groupby(month_col, dropna=False)[metric_total]
        .sum(min_count=1)
        .sort_index()
    )

    if len(monthly_totals) < 2:
        return [
            make_finding(
                stage="diagnostics",
                category="month_over_month_total_volatility",
                status="info",
                message=(
                    "Could not check month-to-month total volatility because fewer than "
                    "two months of data were available."
                ),
                count=0,
            )
        ]

    change_threshold = get_diagnostic_threshold(
        "month_over_month_total_volatility",
        "warning_pct_change_threshold",
    )

    comparison_df = monthly_totals.rename("current_total").reset_index()
    comparison_df["previous_month"] = comparison_df[month_col].shift(1)
    comparison_df["previous_total"] = comparison_df["current_total"].shift(1)
    comparison_df = comparison_df.dropna(subset=["previous_total"]).copy()
    if comparison_df.empty:
        return [
            make_finding(
                stage="diagnostics",
                category="month_over_month_total_volatility",
                status="info",
                message=(
                    "Could not check month-to-month total volatility because a "
                    "previous-month comparison was not available."
                ),
                count=0,
            )
        ]

    zero_previous_mask = comparison_df["previous_total"] == 0
    comparison_df["pct_change"] = (
        comparison_df["current_total"] - comparison_df["previous_total"]
    ) / comparison_df["previous_total"].replace(0, np.nan)
    comparison_df.loc[
        zero_previous_mask & comparison_df["current_total"].eq(0),
        "pct_change",
    ] = 0.0
    comparison_df.loc[
        zero_previous_mask & comparison_df["current_total"].ne(0),
        "pct_change",
    ] = np.inf
    comparison_df["abs_pct_change"] = comparison_df["pct_change"].abs()

    volatile_months = comparison_df[comparison_df["abs_pct_change"] > change_threshold].copy()

    if volatile_months.empty:
        return [
            make_finding(
                stage="diagnostics",
                category="month_over_month_total_volatility",
                status="success",
                message=(
                    f"No months changed by more than {change_threshold:.0%} versus the "
                    "previous month."
                ),
                count=0,
                metadata={"warning_pct_change_threshold": change_threshold},
            )
        ]

    def _format_pct_change(value: float) -> str:
        if np.isinf(value):
            return "an undefined percentage jump from 0"
        sign = "+" if value > 0 else ""
        return f"{sign}{value:.0%}"

    sample_values = [
        (
            f"{_format_month_label(row[month_col])}: {row['current_total']:.2f} versus "
            f"{row['previous_total']:.2f} in "
            f"{_format_month_label(row['previous_month'])} "
            f"({_format_pct_change(row['pct_change'])})."
        )
        for _, row in volatile_months.head(sample_limit).iterrows()
    ]

    findings = [
        make_finding(
            stage="diagnostics",
            category="month_over_month_total_volatility",
            status="warning",
            message=(
                f"Found {len(volatile_months)} months where the total "
                f"{metric_total.replace('_', ' ')} changed by more than "
                f"{change_threshold:.0%} versus the previous month. Large swings like this "
                "often mean a month is missing, partial, or counted twice."
            ),
            column=metric_total,
            count=len(volatile_months),
            sample_values=sample_values,
            metadata={
                "warning_pct_change_threshold": change_threshold,
                "sample_rows": volatile_months.head(sample_limit)
                .assign(
                    month_label=lambda x: x[month_col].map(_format_month_label),
                    previous_month_label=lambda x: x["previous_month"].map(_format_month_label),
                )
                .replace({pd.NaT: None, pd.NA: None})
                .to_dict("records"),
            },
        )
    ]
    return findings


def detect_numeric_coercion_loss(
    df: pd.DataFrame,
    numeric_columns: list[str],
    *,
    sample_limit: int = 10,
) -> tuple[list[dict[str, Any]], pd.DataFrame]:
    """Catch unreadable numeric tokens before they silently drop out of totals.

    This exists because text like "ten kg" or "1..2" can turn into missing
    values during numeric coercion without causing a hard failure, which then
    understates totals and emissions. The report should surface those tokens
    clearly so they can be fixed before users trust the results.
    """
    missing_columns = [column for column in numeric_columns if column not in df.columns]
    if missing_columns:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="numeric_coercion_loss",
                    status="info",
                    message=(
                        "Could not check numeric coercion loss because these columns are "
                        f"missing: {missing_columns}"
                    ),
                    metadata={"missing_columns": missing_columns},
                )
            ],
            pd.DataFrame(),
        )

    allowed_loss_count = int(
        get_diagnostic_threshold(
            "numeric_coercion_loss",
            "allowed_loss_count",
        )
    )
    allowed_loss_count = max(allowed_loss_count, 0)

    bad_token_frames: list[pd.DataFrame] = []
    for column in numeric_columns:
        raw_values = df[column]
        coerced_values = pd.to_numeric(raw_values, errors="coerce")
        raw_strings = raw_values.astype("string")
        normalized_strings = raw_strings.str.strip().str.lower()
        meaningful_raw_mask = raw_values.notna() & ~normalized_strings.isin(MISSING_TEXT_TOKENS)
        became_missing_mask = meaningful_raw_mask & coerced_values.isna()

        if not became_missing_mask.any():
            continue

        column_bad_tokens = df.loc[became_missing_mask, [column]].copy()
        column_bad_tokens.insert(0, "row_index", column_bad_tokens.index)
        column_bad_tokens.insert(1, "column", column)
        column_bad_tokens = column_bad_tokens.rename(columns={column: "raw_value"})
        bad_token_frames.append(column_bad_tokens)

    if not bad_token_frames:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="numeric_coercion_loss",
                    status="success",
                    message="All required numeric fields could be read as numbers.",
                    count=0,
                    metadata={
                        "allowed_loss_count": allowed_loss_count,
                        "numeric_columns": numeric_columns,
                    },
                )
            ],
            pd.DataFrame(columns=["row_index", "column", "raw_value"]),
        )

    bad_tokens_df = pd.concat(bad_token_frames, ignore_index=True)
    bad_token_count = len(bad_tokens_df)
    sample_rows = (
        bad_tokens_df.head(sample_limit)
        .replace({pd.NaT: None, pd.NA: None, np.nan: None})
        .to_dict("records")
    )
    sample_values = [
        f"Row {row['row_index']} in '{row['column']}' could not be read: {row['raw_value']}"
        for row in sample_rows
    ]

    status = "error" if bad_token_count > allowed_loss_count else "warning"
    message = (
        f"Found {bad_token_count} non-empty value{'' if bad_token_count == 1 else 's'} in "
        "required numeric fields that could not be read as numbers and would drop out of "
        "the report totals."
    )
    if status == "error":
        message += " Please fix these values before relying on the report."
    else:
        message += (
            " This is within the configured tolerance, but it still needs review because "
            "those values will be excluded from totals."
        )

    findings = [
        make_finding(
            stage="diagnostics",
            category="numeric_coercion_loss",
            status=status,
            message=message,
            count=bad_token_count,
            sample_values=sample_values,
            metadata={
                "allowed_loss_count": allowed_loss_count,
                "numeric_columns": numeric_columns,
                "sample_rows": sample_rows,
            },
        )
    ]
    return findings, bad_tokens_df


def check_aggregation_reconciliation(
    raw_df: pd.DataFrame,
    monthly_product_df: pd.DataFrame,
    monthly_category_df: pd.DataFrame,
    metric_col: str,
    *,
    rel_error_threshold: float | None = None,
) -> tuple[list[dict[str, Any]], pd.DataFrame]:
    """Reconcile totals across raw rows and both report aggregation grains.

    This exists to catch filtering, grouping, or join mistakes that let summary
    tables drift away from the raw metric total without causing a hard crash.
    """
    required_sources = {
        "raw_df": raw_df,
        "monthly_product_df": monthly_product_df,
        "monthly_category_df": monthly_category_df,
    }
    missing_columns = {
        source_name: [column for column in [metric_col] if column not in frame.columns]
        for source_name, frame in required_sources.items()
        if metric_col not in frame.columns
    }
    if missing_columns:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="aggregation_reconciliation",
                    status="info",
                    message=(
                        "Could not check aggregation reconciliation because the metric "
                        f"column '{metric_col}' is missing in: {sorted(missing_columns)}"
                    ),
                    metadata={"missing_columns": missing_columns, "metric_col": metric_col},
                )
            ],
            pd.DataFrame(),
        )

    rel_error_threshold = resolve_diagnostic_threshold(
        "aggregation_reconciliation",
        "rel_error_threshold",
        rel_error_threshold,
    )
    rel_error_threshold = max(float(rel_error_threshold), 0.0)

    raw_total = float(pd.to_numeric(raw_df[metric_col], errors="coerce").sum(min_count=1) or 0.0)
    monthly_product_total = float(
        pd.to_numeric(monthly_product_df[metric_col], errors="coerce").sum(min_count=1) or 0.0
    )
    monthly_category_total = float(
        pd.to_numeric(monthly_category_df[metric_col], errors="coerce").sum(min_count=1) or 0.0
    )

    totals = {
        "raw_total": raw_total,
        "monthly_product_total": monthly_product_total,
        "monthly_category_total": monthly_category_total,
    }
    baseline = max((abs(total) for total in totals.values()), default=0.0)
    max_abs_difference = max(totals.values()) - min(totals.values()) if totals else 0.0
    relative_difference = 0.0 if baseline == 0.0 else max_abs_difference / baseline

    export_df = pd.DataFrame(
        [
            {
                "metric_col": metric_col,
                "raw_total": raw_total,
                "monthly_product_total": monthly_product_total,
                "monthly_category_total": monthly_category_total,
                "max_abs_difference": max_abs_difference,
                "relative_difference": relative_difference,
                "rel_error_threshold": rel_error_threshold,
                "is_flagged": relative_difference > rel_error_threshold,
            }
        ]
    )

    status = "error" if relative_difference > rel_error_threshold else "success"
    message = (
        f"Raw total {raw_total:,.3f}, monthly-by-product total {monthly_product_total:,.3f}, "
        f"and monthly-by-category total {monthly_category_total:,.3f} reconcile within the "
        f"{rel_error_threshold:.1%} tolerance."
    )
    if status == "error":
        message = (
            f"Aggregation totals differ by {relative_difference:.4%}, above the "
            f"{rel_error_threshold:.1%} reconciliation tolerance. Raw total: "
            f"{raw_total:,.3f}; monthly-by-product total: {monthly_product_total:,.3f}; "
            f"monthly-by-category total: {monthly_category_total:,.3f}."
        )

    findings = [
        make_finding(
            stage="diagnostics",
            category="aggregation_reconciliation",
            status=status,
            message=message,
            column=metric_col,
            count=int(relative_difference > rel_error_threshold),
            metadata={
                "metric_col": metric_col,
                "raw_total": raw_total,
                "monthly_product_total": monthly_product_total,
                "monthly_category_total": monthly_category_total,
                "max_abs_difference": max_abs_difference,
                "relative_difference": relative_difference,
                "rel_error_threshold": rel_error_threshold,
            },
        )
    ]
    return findings, export_df


def _check_top_share_concentration(
    df: pd.DataFrame,
    metric_col: str,
    *,
    group_col: str,
    diagnostic_name: str,
    threshold_key: str,
    subject_label: str,
    threshold_override: float | None = None,
) -> list[dict[str, Any]]:
    """Check whether one grouped value dominates the report total.

    This exists because highly concentrated totals can mean the dataset is
    genuinely dominated by one product or category, but they can also be an
    early sign of mapping, unit, or coverage problems that would distort the
    story a catering manager takes from the report.
    """
    missing_columns = [column for column in [group_col, metric_col] if column not in df.columns]
    if missing_columns:
        return [
            make_finding(
                stage="diagnostics",
                category=diagnostic_name,
                status="info",
                message=(
                    f"Could not check for {subject_label} concentration because these "
                    f"columns are missing: {missing_columns}"
                ),
                metadata={"missing_columns": missing_columns},
            )
        ]

    threshold_pct = resolve_diagnostic_threshold(
        diagnostic_name,
        threshold_key,
        threshold_override,
    )
    threshold_pct = max(float(threshold_pct), 0.0)

    grouped_totals = (
        df.assign(_metric_value=pd.to_numeric(df[metric_col], errors="coerce"))
        .dropna(subset=[group_col])
        .groupby(group_col, dropna=False)["_metric_value"]
        .sum(min_count=1)
        .dropna()
        .sort_values(ascending=False)
    )

    if grouped_totals.empty:
        return [
            make_finding(
                stage="diagnostics",
                category=diagnostic_name,
                status="info",
                message=(
                    f"Could not check for {subject_label} concentration because no valid "
                    "totals were available."
                ),
                metadata={"threshold_pct": threshold_pct, "metric_col": metric_col},
            )
        ]

    total_metric = float(grouped_totals.sum())
    if total_metric <= 0:
        return [
            make_finding(
                stage="diagnostics",
                category=diagnostic_name,
                status="info",
                message=(
                    f"Could not check for {subject_label} concentration because the total "
                    "metric was zero or below."
                ),
                metadata={"threshold_pct": threshold_pct, "metric_col": metric_col},
            )
        ]

    top_value = str(grouped_totals.index[0])
    top_total = float(grouped_totals.iloc[0])
    top_share = top_total / total_metric
    metric_label = metric_col.replace("_", " ")

    if top_share > threshold_pct:
        return [
            make_finding(
                stage="diagnostics",
                category=diagnostic_name,
                status="info",
                message=(
                    f"'{top_value}' accounts for {top_share:.1%} of total {metric_label}, "
                    f"above the {threshold_pct:.0%} {subject_label} concentration threshold."
                ),
                count=1,
                sample_values=[
                    f"{top_value}: {top_total:.2f} of {total_metric:.2f} ({top_share:.1%})"
                ],
                metadata={
                    "metric_col": metric_col,
                    "threshold_pct": threshold_pct,
                    f"top_{group_col}": top_value,
                    f"top_{group_col}_total": top_total,
                    f"top_{group_col}_share": top_share,
                },
            )
        ]

    return [
        make_finding(
            stage="diagnostics",
            category=diagnostic_name,
            status="success",
            message=(
                f"No single {subject_label} exceeded {threshold_pct:.0%} of total {metric_label}."
            ),
            count=0,
            metadata={
                "metric_col": metric_col,
                "threshold_pct": threshold_pct,
                f"top_{group_col}": top_value,
                f"top_{group_col}_total": top_total,
                f"top_{group_col}_share": top_share,
            },
        )
    ]


def check_single_product_dominance(
    df: pd.DataFrame,
    metric_col: str,
    *,
    product_col: str = "product",
    threshold_pct: float | None = None,
) -> list[dict[str, Any]]:
    """Flag a single product dominating totals before the report is over-read.

    This exists because one unusually dominant product can make overall report
    metrics look more representative or diversified than they really are.
    """
    return _check_top_share_concentration(
        df,
        metric_col,
        group_col=product_col,
        diagnostic_name="single_product_dominance",
        threshold_key="threshold_pct",
        subject_label="product",
        threshold_override=threshold_pct,
    )


def check_category_concentration(
    df: pd.DataFrame,
    metric_col: str,
    *,
    category_col: str = "category",
) -> list[dict[str, Any]]:
    """Flag heavily concentrated category mixes before users over-read the summary.

    This exists because one category dominating the report can be a real pattern,
    but it can also point to a mapping issue or a dataset that is much less
    balanced than the headline figures imply.
    """
    return _check_top_share_concentration(
        df,
        metric_col,
        group_col=category_col,
        diagnostic_name="category_concentration",
        threshold_key="threshold_pct",
        subject_label="category",
    )


def check_missing_weeks_within_month(
    df: pd.DataFrame,
    *,
    date_col: str = "date",
    max_gap_days: float | None = None,
    sample_limit: int = 6,
) -> list[dict[str, Any]]:
    """Flag long within-month stretches with no transactions in day-level data.

    This exists to catch likely missing extracts in datasets that normally
    arrive daily or weekly. It deliberately skips month-level or one-date-per-
    month series, because those inputs cannot support a reliable missing-weeks
    check and would otherwise create false alarms.
    """
    if date_col not in df.columns:
        return [
            make_finding(
                stage="diagnostics",
                category="missing_weeks_within_month",
                status="info",
                message=(
                    f"Could not check for missing weeks within month because '{date_col}' "
                    "is missing."
                ),
                metadata={"missing_columns": [date_col]},
            )
        ]

    max_gap_days = max(
        int(
            resolve_diagnostic_threshold(
                "missing_weeks_within_month",
                "max_gap_days",
                max_gap_days,
            )
        ),
        1,
    )

    if not _dates_support_within_month_gap_detection(df[date_col]):
        return []

    unique_dates = (
        pd.to_datetime(df[date_col], errors="coerce")
        .dropna()
        .dt.normalize()
        .drop_duplicates()
        .sort_values()
    )

    if unique_dates.empty:
        return []

    gap_rows: list[dict[str, Any]] = []
    for month, month_dates in unique_dates.groupby(unique_dates.dt.to_period("M")):
        month_dates = month_dates.sort_values().reset_index(drop=True)

        month_start = month.start_time.normalize()
        month_end = month.end_time.normalize()
        first_date = month_dates.iloc[0]
        missing_start_days = int((first_date - month_start).days)
        if missing_start_days > max_gap_days:
            gap_rows.append(
                {
                    "month_year": month,
                    "gap_position": "start_of_month",
                    "last_transaction_date": None,
                    "next_transaction_date": first_date.date().isoformat(),
                    "missing_start_date": month_start.date().isoformat(),
                    "missing_end_date": (first_date - timedelta(days=1)).date().isoformat(),
                    "missing_day_count": missing_start_days,
                }
            )

        for previous_date, next_date in pairwise(month_dates):
            missing_day_count = int((next_date - previous_date).days - 1)
            if missing_day_count <= max_gap_days:
                continue

            gap_rows.append(
                {
                    "month_year": month,
                    "gap_position": "within_month",
                    "last_transaction_date": previous_date.date().isoformat(),
                    "next_transaction_date": next_date.date().isoformat(),
                    "missing_start_date": (previous_date + timedelta(days=1)).date().isoformat(),
                    "missing_end_date": (next_date - timedelta(days=1)).date().isoformat(),
                    "missing_day_count": missing_day_count,
                }
            )

        last_date = month_dates.iloc[-1]
        missing_end_days = int((month_end - last_date).days)
        if missing_end_days > max_gap_days:
            gap_rows.append(
                {
                    "month_year": month,
                    "gap_position": "end_of_month",
                    "last_transaction_date": last_date.date().isoformat(),
                    "next_transaction_date": None,
                    "missing_start_date": (last_date + timedelta(days=1)).date().isoformat(),
                    "missing_end_date": month_end.date().isoformat(),
                    "missing_day_count": missing_end_days,
                }
            )

    if not gap_rows:
        return [
            make_finding(
                stage="diagnostics",
                category="missing_weeks_within_month",
                status="success",
                message=(f"No within-month date gaps longer than {max_gap_days} days were found."),
                count=0,
                metadata={"max_gap_days": max_gap_days},
            )
        ]

    gap_df = pd.DataFrame(gap_rows).sort_values(
        ["missing_day_count", "month_year", "missing_start_date"],
        ascending=[False, True, True],
    )

    sample_values = [
        (
            f"{_format_month_label(row['month_year'])}: no transactions from "
            f"{row['missing_start_date']} to {row['missing_end_date']} "
            f"({int(row['missing_day_count'])} consecutive days)."
        )
        for _, row in gap_df.head(sample_limit).iterrows()
    ]

    return [
        make_finding(
            stage="diagnostics",
            category="missing_weeks_within_month",
            status="info",
            message=(
                f"Found {len(gap_df)} within-month date gaps longer than {max_gap_days} "
                "days. In data that normally arrives daily or weekly, this can mean part "
                "of a month's transactions were missed."
            ),
            count=len(gap_df),
            sample_values=sample_values,
            metadata={
                "max_gap_days": max_gap_days,
                "sample_rows": gap_df.head(sample_limit).to_dict("records"),
            },
        )
    ]


def _format_month_label(value: Any) -> str:
    """Format month-like values consistently across month-based diagnostics."""
    return pd.Period(str(value), freq="M").strftime("%b %Y")


def _format_category_month_missing_sample(category: Any, month: Any) -> str:
    """Turn a missing category-month combo into a plain-English sample line."""
    category_text = str(category).replace("&", "and").strip()
    return f"{category_text} missing during {_format_month_label(month)}"


def check_diner_meal_reasonableness(
    diner_meal_mapping: dict[Any, Any],
    *,
    low: float | None = None,
    high: float | None = None,
    error_if_flagged_months: int | None = None,
    sample_limit: int = 6,
) -> tuple[list[dict[str, Any]], pd.DataFrame]:
    """Flag unusual denominator months before intensity KPIs become misleading.

    This exists because diner or meal counts are denominator data for
    per-diner and per-meal metrics. A few unusual denominator months can make
    those KPIs look better or worse than they really are.
    """
    if not diner_meal_mapping:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="diner_meal_count_reasonableness",
                    status="info",
                    message=(
                        "Could not check diner or meal count reasonableness because no "
                        "monthly diner-meal mapping was provided."
                    ),
                    count=0,
                )
            ],
            pd.DataFrame(),
        )

    low_threshold = resolve_diagnostic_threshold(
        "diner_meal_count_reasonableness",
        "low_ratio_threshold",
        low,
    )
    high_threshold = resolve_diagnostic_threshold(
        "diner_meal_count_reasonableness",
        "high_ratio_threshold",
        high,
    )
    escalation_threshold = max(
        1,
        int(
            resolve_diagnostic_threshold(
                "diner_meal_count_reasonableness",
                "error_if_flagged_months",
                float(error_if_flagged_months) if error_if_flagged_months is not None else None,
            )
        ),
    )

    monthly_counts = pd.Series(diner_meal_mapping, dtype="object").rename("diner_meal_count")
    monthly_counts.index = [
        pd.Period(str(month), freq="M") if pd.notna(month) else pd.NA
        for month in monthly_counts.index
    ]
    monthly_counts = pd.to_numeric(monthly_counts, errors="coerce").sort_index()
    monthly_counts = monthly_counts[monthly_counts.index.notna()]

    if monthly_counts.empty:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="diner_meal_count_reasonableness",
                    status="info",
                    message=(
                        "Could not check diner or meal count reasonableness because the "
                        "monthly counts could not be read as numbers."
                    ),
                    count=0,
                )
            ],
            pd.DataFrame(),
        )

    valid_counts = monthly_counts.dropna()
    if valid_counts.empty:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="diner_meal_count_reasonableness",
                    status="info",
                    message=(
                        "Could not check diner or meal count reasonableness because every "
                        "monthly count was missing."
                    ),
                    count=0,
                )
            ],
            pd.DataFrame(),
        )

    median_count = float(valid_counts.median())
    if median_count <= 0:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="diner_meal_count_reasonableness",
                    status="info",
                    message=(
                        "Could not check diner or meal count reasonableness because the "
                        "typical monthly count was zero or below."
                    ),
                    count=0,
                    metadata={"median_count": median_count},
                )
            ],
            pd.DataFrame(),
        )

    qc_df = pd.DataFrame(
        {
            "month_year": monthly_counts.index.astype(str),
            "month_label": [_format_month_label(month) for month in monthly_counts.index],
            "diner_meal_count": monthly_counts.to_numpy(),
        }
    )
    qc_df["median_count"] = median_count
    qc_df["ratio_to_median"] = qc_df["diner_meal_count"] / median_count
    qc_df["is_flagged"] = (
        qc_df["ratio_to_median"].lt(low_threshold) | qc_df["ratio_to_median"].gt(high_threshold)
    ) & qc_df["ratio_to_median"].notna()
    qc_df["flag_reason"] = np.where(
        qc_df["ratio_to_median"].isna(),
        "Count is missing, so this month could not be compared with the typical month.",
        np.where(
            qc_df["ratio_to_median"] < low_threshold,
            (
                "Count is lower than expected for this dataset and may make per-diner "
                "metrics look too high."
            ),
            np.where(
                qc_df["ratio_to_median"] > high_threshold,
                (
                    "Count is higher than expected for this dataset and may make "
                    "per-diner metrics look too low."
                ),
                "",
            ),
        ),
    )

    flagged_df = qc_df[qc_df["is_flagged"]].copy()
    flagged_count = len(flagged_df)
    missing_count = int(qc_df["diner_meal_count"].isna().sum())

    if flagged_count == 0:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="diner_meal_count_reasonableness",
                    status="success",
                    message=(
                        "Monthly diner or meal counts looked broadly consistent across "
                        "the reporting period."
                    ),
                    count=0,
                    metadata={
                        "median_count": median_count,
                        "low_ratio_threshold": low_threshold,
                        "high_ratio_threshold": high_threshold,
                        "error_if_flagged_months": escalation_threshold,
                        "missing_month_count": missing_count,
                    },
                )
            ],
            qc_df,
        )

    status = "error" if flagged_count >= escalation_threshold else "warning"
    sample_values = [
        (
            f"{row['month_label']}: {row['diner_meal_count']:.0f} versus a median of "
            f"{row['median_count']:.0f} ({row['ratio_to_median']:.2f}x)."
        )
        for _, row in flagged_df.head(sample_limit).iterrows()
    ]

    findings = [
        make_finding(
            stage="diagnostics",
            category="diner_meal_count_reasonableness",
            status=status,
            message=(
                f"Found {flagged_count} month{'' if flagged_count == 1 else 's'} where the "
                "diner or meal count was much lower or higher than usual for this dataset. "
                "This can make per-diner and per-meal figures look misleading even when the "
                "food data is correct."
            ),
            count=flagged_count,
            sample_values=sample_values,
            metadata={
                "median_count": median_count,
                "low_ratio_threshold": low_threshold,
                "high_ratio_threshold": high_threshold,
                "error_if_flagged_months": escalation_threshold,
                "missing_month_count": missing_count,
                "sample_rows": flagged_df.head(sample_limit)
                .replace({pd.NaT: None, pd.NA: None, np.nan: None})
                .to_dict("records"),
            },
        )
    ]
    return findings, qc_df


def check_missing_internal_months(
    df: pd.DataFrame,
    *,
    month_col: str = "month_year",
    date_col: str = "date",
) -> list[dict[str, Any]]:
    """Flag fully missing months before short report windows are misread as complete.

    This exists because a missing internal month can distort averages, trends,
    and period comparisons substantially, especially in the common three-month
    reporting window where one absent month means a third of the expected period
    is missing.
    """
    try:
        monthly_df = ensure_month_year_column(
            df[[*df.columns]].copy(),
            date_col=date_col,
            month_col=month_col,
        )
    except ValueError as exc:
        return [
            make_finding(
                stage="diagnostics",
                category="missing_internal_months",
                status="info",
                message=f"Could not check for missing internal months: {exc}",
                metadata={"missing_columns": [date_col, month_col]},
            )
        ]

    observed_months = (
        monthly_df[month_col]
        .dropna()
        .map(lambda value: pd.Period(str(value), freq="M"))
        .sort_values()
        .unique()
    )

    if len(observed_months) < 2:
        return [
            make_finding(
                stage="diagnostics",
                category="missing_internal_months",
                status="success",
                message="No internal months are missing.",
                count=0,
            )
        ]

    full_month_range = pd.period_range(observed_months.min(), observed_months.max(), freq="M")
    missing_months = [month for month in full_month_range if month not in set(observed_months)]

    if not missing_months:
        return [
            make_finding(
                stage="diagnostics",
                category="missing_internal_months",
                status="success",
                message="No internal months are missing.",
                count=0,
            )
        ]

    missing_month_labels = [_format_month_label(month) for month in missing_months]
    expected_month_count = len(full_month_range)
    missing_share = len(missing_months) / expected_month_count if expected_month_count else 0.0
    share_message = ""
    if expected_month_count == 3 and len(missing_months) == 1:
        share_message = (
            " In a three-month report window, that means one-third of the expected "
            "period is missing."
        )
    elif missing_share >= (1 / 3):
        share_message = (
            f" That means about {missing_share:.0%} of the expected months in this "
            "period are missing."
        )

    return [
        make_finding(
            stage="diagnostics",
            category="missing_internal_months",
            status="warning",
            message=(
                f"Found {len(missing_months)} missing internal "
                f"month{'' if len(missing_months) == 1 else 's'} between "
                f"{_format_month_label(full_month_range.min())} and "
                f"{_format_month_label(full_month_range.max())}: "
                f"{', '.join(missing_month_labels)}.{share_message}"
            ),
            count=len(missing_months),
            sample_values=missing_month_labels,
            metadata={
                "missing_months": [str(month) for month in missing_months],
                "expected_month_count": int(expected_month_count),
                "missing_month_share": float(missing_share),
            },
        )
    ]


def detect_category_discontinuity(
    df: pd.DataFrame,
    metric_total: str,
    *,
    category_col: str = "category",
    month_col: str = "month_year",
    date_col: str = "date",
    sample_limit: int = 6,
) -> tuple[list[dict[str, Any]], pd.DataFrame]:
    """Flag categories that disappear mid-period and then return.

    This exists because a category that is present, then missing for an internal
    month, and then present again is often a data gap rather than a real product
    exit. Catching that pattern helps users trust short reporting windows where
    one missing middle month can change the story materially.
    """
    missing_columns = [
        column for column in [category_col, metric_total] if column not in df.columns
    ]
    if missing_columns:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="category_discontinuity",
                    status="info",
                    message=(
                        "Could not check category continuity because these columns are "
                        f"missing: {missing_columns}"
                    ),
                    metadata={"missing_columns": missing_columns},
                )
            ],
            pd.DataFrame(),
        )

    try:
        monthly_df = ensure_month_year_column(
            df[[*df.columns]].copy(),
            date_col=date_col,
            month_col=month_col,
        )
    except ValueError as exc:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="category_discontinuity",
                    status="info",
                    message=f"Could not check category continuity: {exc}",
                    metadata={"missing_columns": [date_col, month_col]},
                )
            ],
            pd.DataFrame(),
        )

    working = monthly_df.copy()
    working[metric_total] = pd.to_numeric(working[metric_total], errors="coerce")
    valid_rows = working[
        working[category_col].notna() & working[month_col].notna() & working[metric_total].notna()
    ].copy()

    if valid_rows.empty:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="category_discontinuity",
                    status="success",
                    message="No category continuity issues found.",
                    count=0,
                    metadata={
                        "min_gap_months": int(
                            get_diagnostic_threshold(
                                "category_discontinuity",
                                "min_gap_months",
                            )
                        )
                    },
                )
            ],
            pd.DataFrame(),
        )

    min_gap_months = int(
        get_diagnostic_threshold(
            "category_discontinuity",
            "min_gap_months",
        )
    )
    min_gap_months = max(min_gap_months, 1)

    monthly_category_totals = (
        valid_rows.groupby([category_col, month_col], dropna=False)[metric_total]
        .sum(min_count=1)
        .reset_index()
    )
    monthly_category_totals[month_col] = monthly_category_totals[month_col].apply(
        lambda value: pd.Period(str(value), freq="M")
    )
    monthly_category_totals = monthly_category_totals.sort_values([category_col, month_col])

    all_months = pd.period_range(
        monthly_category_totals[month_col].min(),
        monthly_category_totals[month_col].max(),
        freq="M",
    )
    all_categories = (
        monthly_category_totals[category_col].dropna().astype(str).sort_values().unique().tolist()
    )

    if len(all_months) < 3 or not all_categories:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="category_discontinuity",
                    status="success",
                    message="No category continuity issues found.",
                    count=0,
                    metadata={"min_gap_months": min_gap_months},
                )
            ],
            pd.DataFrame(),
        )

    complete_index = pd.MultiIndex.from_product(
        [all_categories, all_months],
        names=[category_col, month_col],
    )
    monthly_category_panel = (
        monthly_category_totals.assign(**{category_col: lambda x: x[category_col].astype(str)})
        .set_index([category_col, month_col])
        .reindex(complete_index)
        .reset_index()
    )
    monthly_category_panel["metric_total_value"] = monthly_category_panel[metric_total]
    monthly_category_panel["has_non_zero_data"] = (
        monthly_category_panel[metric_total].fillna(0).gt(0)
    )

    discontinuity_rows: list[dict[str, Any]] = []
    for category, category_panel in monthly_category_panel.groupby(category_col, sort=True):
        category_panel = category_panel.sort_values(month_col).reset_index(drop=True)
        active_positions = np.flatnonzero(category_panel["has_non_zero_data"].to_numpy())
        if len(active_positions) < 2:
            continue

        for start_position, end_position in pairwise(active_positions):
            gap_size = int(end_position - start_position - 1)
            if gap_size < min_gap_months:
                continue

            gap_rows = category_panel.iloc[start_position + 1 : end_position].copy()
            if gap_rows.empty:
                continue
            if gap_rows["has_non_zero_data"].any():
                continue

            gap_months = gap_rows[month_col].tolist()
            discontinuity_rows.append(
                {
                    "category": category,
                    "last_month_with_data": category_panel.iloc[start_position][month_col],
                    "first_month_back_with_data": category_panel.iloc[end_position][month_col],
                    "gap_month_count": gap_size,
                    "gap_months": ", ".join(_format_month_label(month) for month in gap_months),
                }
            )

    discontinuity_df = pd.DataFrame(discontinuity_rows)
    if discontinuity_df.empty:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="category_discontinuity",
                    status="success",
                    message="No category continuity issues found.",
                    count=0,
                    metadata={"min_gap_months": min_gap_months},
                )
            ],
            pd.DataFrame(
                columns=[
                    "category",
                    "last_month_with_data",
                    "first_month_back_with_data",
                    "gap_month_count",
                    "gap_months",
                ]
            ),
        )

    discontinuity_df = discontinuity_df.sort_values(
        ["gap_month_count", "category"],
        ascending=[False, True],
    ).reset_index(drop=True)

    sample_values = [
        (
            f"{row['category']} is missing in {row['gap_months']} and then appears "
            f"again in {_format_month_label(row['first_month_back_with_data'])}."
        )
        for _, row in discontinuity_df.head(sample_limit).iterrows()
    ]

    findings = [
        make_finding(
            stage="diagnostics",
            category="category_discontinuity",
            status="warning",
            message=(
                f"Found {len(discontinuity_df)} category continuity issues where a "
                f"category had data, went missing for at least {min_gap_months} internal "
                f"month{'' if min_gap_months == 1 else 's'}, and then came back. This "
                "usually points to a missing month of data rather than a real category "
                "disappearance."
            ),
            column=metric_total,
            count=len(discontinuity_df),
            sample_values=sample_values,
            metadata={
                "min_gap_months": min_gap_months,
                "sample_rows": discontinuity_df.head(sample_limit)
                .assign(
                    last_month_with_data_label=lambda x: x["last_month_with_data"].map(
                        _format_month_label
                    ),
                    first_month_back_with_data_label=lambda x: x["first_month_back_with_data"].map(
                        _format_month_label
                    ),
                )
                .replace({pd.NaT: None, pd.NA: None})
                .to_dict("records"),
            },
        )
    ]

    export_df = discontinuity_df.assign(
        last_month_with_data=lambda x: x["last_month_with_data"].astype(str),
        first_month_back_with_data=lambda x: x["first_month_back_with_data"].astype(str),
    )
    return findings, export_df


def clean_weight_column(
    df: pd.DataFrame,
    weight_col: str,
    verbose: bool = True,
) -> pd.DataFrame:
    """Clean a weight column and coerce numeric values."""
    if weight_col not in df.columns:
        raise ValueError(f"Column '{weight_col}' not found. Available: {df.columns.tolist()}")

    out = df.copy()
    original_values = out[weight_col].copy()
    original_na_count = original_values.isna().sum()
    if pd.api.types.is_numeric_dtype(out[weight_col]):
        return out

    cleaned_values = out[weight_col].astype(str)
    symbol_pattern = r"[\$£€¥₹#%]|kg|lb|lbs|oz|g|grams|pounds|kilograms|ounces"
    cleaned_values = cleaned_values.str.replace(",", "", regex=False).str.strip()
    cleaned_values = cleaned_values.str.replace(
        symbol_pattern, "", case=False, regex=True
    ).str.strip()
    cleaned_values = cleaned_values.replace("", pd.NA).replace("nan", pd.NA)

    numeric_values = pd.to_numeric(cleaned_values, errors="coerce")

    if verbose:
        new_na_count = numeric_values.isna().sum()
        newly_created_nas = int(new_na_count - original_na_count)
        if newly_created_nas > 0:
            logger.warning(
                "Weight cleaning introduced %d new missing values in '%s'",
                newly_created_nas,
                weight_col,
            )

    out[weight_col] = numeric_values
    return out


def validate_date_column(df: pd.DataFrame, date_col: str) -> None:
    """Validate that date column exists and has no missing values."""
    if date_col not in df.columns:
        raise ValueError(f"Column '{date_col}' not found in DataFrame.")
    na_count = int(df[date_col].isna().sum())
    if na_count > 0:
        raise AssertionError(f"There are {na_count} missing values in the date column.")


def check_required_columns(
    df: pd.DataFrame,
    serving: bool = False,
    report_mode: str | None = None,
) -> bool:
    """Verify that DataFrame includes required report columns."""
    if report_mode is None:
        report_mode = "serving" if serving else "procurement"

    mode = normalize_report_mode(report_mode)
    required = required_columns_for_mode(mode)
    missing = [column for column in required if column not in df.columns]
    return len(missing) == 0


def baseline_pre_flight_checks(
    df: pd.DataFrame,
    diner_meal_mapping: dict[Any, Any],
    serving: bool = False,
) -> pd.DataFrame:
    """Run strict baseline checks and raise on violations."""
    out = df.copy()

    if not pd.api.types.is_datetime64_any_dtype(out["date"]):
        out["date"] = pd.to_datetime(out["date"], errors="coerce")

    if out["date"].isna().any():
        raise AssertionError("There are missing (NA/NaT) values in the 'date' column.")

    if not check_required_columns(out, serving=serving):
        raise AssertionError("Required columns are missing.")

    metric_col = metric_for_mode("serving" if serving else "procurement")
    if (out[metric_col] <= 0).sum() > 0:
        raise AssertionError(f"There are zero or negative values in '{metric_col}'.")

    alignment = compute_month_alignment(
        out["month_year"].dropna().unique(), diner_meal_mapping.keys()
    )
    if alignment["missing_in_mapping"]:
        raise AssertionError(
            f"Dates not found in diner_meal_mapping: {alignment['missing_in_mapping']}"
        )

    return out


def ensure_date_alignment(
    df: pd.DataFrame,
    diner_meal_mapping: dict[Any, Any],
) -> dict[str, list[pd.Period]]:
    """Return month alignment diff between data and diner-meal mapping."""
    if "month_year" not in df.columns:
        return {"missing_in_mapping": [], "missing_in_data": []}
    return compute_month_alignment(df["month_year"].dropna().unique(), diner_meal_mapping.keys())


def check_zero_category_month_combos(
    monthly_data: pd.DataFrame,
    metric_col: str,
) -> list[dict[str, Any]]:
    """Return structured findings for missing/zero category x month combos."""
    findings: list[dict[str, Any]] = []
    if "month_year" not in monthly_data.columns or "category" not in monthly_data.columns:
        return findings
    if metric_col not in monthly_data.columns:
        return findings

    all_months = monthly_data["month_year"].dropna().unique()
    all_categories = monthly_data["category"].dropna().unique()

    expected = {(cat, month) for month in all_months for cat in all_categories}
    actual = set(zip(monthly_data["category"], monthly_data["month_year"], strict=True))
    missing = sorted(expected - actual)

    if missing:
        findings.append(
            make_finding(
                stage="diagnostics",
                category="missing_category_month_combos",
                status="warning",
                message=f"Missing {len(missing)} category×month combinations.",
                count=len(missing),
                sample_values=[
                    _format_category_month_missing_sample(cat, month) for cat, month in missing[:10]
                ],
            )
        )

    zero_rows = monthly_data[monthly_data[metric_col] == 0]
    if not zero_rows.empty:
        combos = [
            f"{row['category']} / {row['month_year']}"
            for _, row in zero_rows[["category", "month_year"]].head(10).iterrows()
        ]
        findings.append(
            make_finding(
                stage="diagnostics",
                category="zero_category_month_combos",
                status="warning",
                message=(
                    f"Found {len(zero_rows)} category×month rows with zero values for "
                    f"'{metric_col}'."
                ),
                count=len(zero_rows),
                sample_values=combos,
            )
        )

    return findings


def identify_potentially_abnormal_weight_meat_items(
    df: pd.DataFrame,
    quantity_col: str = "quantity",
    category_col: str = "category",
) -> pd.DataFrame | bool:
    """Identify meat rows with suspicious quantities or fractional counts."""
    out = df.copy()
    out[quantity_col] = pd.to_numeric(out[quantity_col], errors="coerce")
    meat_categories = get_meat_categories(lowercase=True)
    large_quantity_threshold = get_diagnostic_threshold(
        "meat_quantity_reasonableness",
        "large_quantity_threshold",
    )

    if not out[category_col].fillna("").astype(str).str.lower().isin(meat_categories).any():
        raise AssertionError("No rows found where category is in meat categories.")

    out["has_decimal"] = (~(out[quantity_col] % 1 == 0)).astype("boolean")
    out["over_large_quantity_threshold"] = (out[quantity_col] > large_quantity_threshold).astype(
        "boolean"
    )
    out["quantity_may_indicate_total_weight"] = (
        out["has_decimal"] | out["over_large_quantity_threshold"]
    ).astype("boolean")

    out["large_quantity_threshold"] = large_quantity_threshold
    mask_meat = out[category_col].fillna("").astype(str).str.lower().isin(meat_categories)
    out.loc[
        ~mask_meat,
        ["has_decimal", "over_large_quantity_threshold", "quantity_may_indicate_total_weight"],
    ] = pd.NA

    flagged = out.loc[out["quantity_may_indicate_total_weight"].fillna(False)]
    if flagged.empty:
        return True
    return flagged


def check_date_distribution(df: pd.DataFrame) -> list[dict[str, Any]]:
    """Check if first/last months look partial based on row count."""
    findings: list[dict[str, Any]] = []

    if "month_year" not in df.columns:
        return findings

    month_counts = df.groupby("month_year", dropna=False).size().sort_index()
    if len(month_counts) < 3:
        return findings

    partial_month_ratio_threshold = get_diagnostic_threshold(
        "date_distribution",
        "partial_month_ratio_threshold",
    )
    median_count = month_counts.iloc[1:-1].median()
    if median_count == 0:
        return findings

    for label, idx in [("First", 0), ("Last", -1)]:
        count = month_counts.iloc[idx]
        month_name = month_counts.index[idx]
        ratio = count / median_count
        if ratio < partial_month_ratio_threshold:
            findings.append(
                make_finding(
                    stage="diagnostics",
                    category="date_distribution",
                    status="warning",
                    message=(
                        f"{label} month ({month_name}) has {count} rows, only {ratio:.0%} "
                        f"of median ({median_count:.0f})."
                    ),
                    count=int(count),
                    metadata={"partial_month_ratio_threshold": partial_month_ratio_threshold},
                )
            )

    return findings


def check_negative_values(df: pd.DataFrame, metric_col: str) -> list[dict[str, Any]]:
    """Return finding if negative values are present."""
    findings: list[dict[str, Any]] = []
    if metric_col not in df.columns:
        return findings

    numeric_metric = pd.to_numeric(df[metric_col], errors="coerce")
    neg_count = int((numeric_metric < 0).sum())
    if neg_count > 0:
        findings.append(
            make_finding(
                stage="diagnostics",
                category="negative_values",
                status="error",
                message=f"Found {neg_count} negative values in '{metric_col}'.",
                column=metric_col,
                count=neg_count,
            )
        )
    else:
        findings.append(
            make_finding(
                stage="diagnostics",
                category="negative_values",
                status="success",
                message="No product has weights that are below 0.",
                column=metric_col,
            )
        )
    return findings


def run_all_diagnostics(
    df: pd.DataFrame,
    diner_meal_mapping: dict[Any, Any],
    serving: bool = False,
    monthly_product_data: pd.DataFrame | None = None,
    monthly_category_data: pd.DataFrame | None = None,
    metric_total: str = "kilos_total",
    pdf_extracted: bool | None = None,
) -> list[dict[str, Any]]:
    """Run report diagnostics and return structured findings only."""
    if serving and metric_total == "kilos_total" and "servings total" in df.columns:
        metric_total = "servings total"

    findings: list[dict[str, Any]] = []
    numeric_coercion_findings, _ = detect_numeric_coercion_loss(df, [metric_total])
    findings.extend(numeric_coercion_findings)

    duplicate_findings, _ = detect_exact_duplicate_rows(df, metric_total)
    findings.extend(duplicate_findings)
    near_duplicate_findings, _ = detect_near_duplicate_product_names(
        df,
        metric_total,
        pdf_extracted=pdf_extracted,
    )
    findings.extend(near_duplicate_findings)
    findings.extend(detect_month_over_month_total_volatility(df, metric_total))
    findings.extend(check_missing_internal_months(df))
    category_discontinuity_findings, _ = detect_category_discontinuity(df, metric_total)
    findings.extend(category_discontinuity_findings)
    denominator_reasonableness_findings, _ = check_diner_meal_reasonableness(diner_meal_mapping)
    findings.extend(denominator_reasonableness_findings)
    findings.extend(check_single_product_dominance(df, metric_total))
    findings.extend(check_category_concentration(df, metric_total))
    if "category" in df.columns and "product" in df.columns and metric_total in df.columns:
        unusual_sales_findings, _ = detect_unusual_sales(
            df,
            summary_col=metric_total,
            product_name_col="product",
            category_col="category",
            return_details=True,
        )
        findings.extend(unusual_sales_findings)
    if "product" in df.columns and metric_total in df.columns:
        per_product_weight_bound_findings, _ = check_per_product_weight_bounds(df, metric_total)
        findings.extend(per_product_weight_bound_findings)
    findings.extend(check_missing_weeks_within_month(df))

    # Required columns
    if check_required_columns(df, serving=serving):
        findings.append(
            make_finding(
                stage="diagnostics",
                category="required_columns",
                status="success",
                message="All required columns present.",
            )
        )
    else:
        mode = normalize_report_mode("serving" if serving else "procurement")
        missing = [column for column in required_columns_for_mode(mode) if column not in df.columns]
        findings.append(
            make_finding(
                stage="diagnostics",
                category="required_columns",
                status="error",
                message=f"Missing required columns: {missing}",
                metadata={"missing_columns": missing},
            )
        )

    # Month alignment
    if "month_year" in df.columns:
        alignment = ensure_date_alignment(df, diner_meal_mapping)
        if alignment["missing_in_mapping"]:
            findings.append(
                make_finding(
                    stage="diagnostics",
                    category="date_alignment",
                    status="warning",
                    message=(
                        f"Months in data but not in diner-meals: {alignment['missing_in_mapping']}"
                    ),
                    count=len(alignment["missing_in_mapping"]),
                )
            )
        if alignment["missing_in_data"]:
            findings.append(
                make_finding(
                    stage="diagnostics",
                    category="date_alignment",
                    status="info",
                    message=(
                        f"Months in diner-meals but not in data: {alignment['missing_in_data']}"
                    ),
                    count=len(alignment["missing_in_data"]),
                )
            )
        if not alignment["missing_in_mapping"] and not alignment["missing_in_data"]:
            findings.append(
                make_finding(
                    stage="diagnostics",
                    category="date_alignment",
                    status="success",
                    message="All months aligned between data and diner-meals.",
                )
            )

    findings.extend(check_date_distribution(df))
    findings.extend(check_negative_values(df, metric_total))

    if monthly_product_data is not None and monthly_category_data is not None:
        aggregation_reconciliation_findings, _ = check_aggregation_reconciliation(
            df,
            monthly_product_data,
            monthly_category_data,
            metric_total,
        )
        findings.extend(aggregation_reconciliation_findings)

    # GBD category validity
    if "category" in df.columns:
        gbd_cats = set(get_GBD_categories())
        gbd_plus = gbd_cats | {"No Matches Found"}
        df_cats = set(df["category"].dropna().astype(str).unique())
        non_gbd = sorted(df_cats - gbd_plus)
        # "No Matches Found" is allowed as a placeholder category, but should not be
        # reported as an expected GBD category if absent from final report data.
        missing_gbd = sorted(gbd_cats - df_cats)

        if non_gbd:
            findings.append(
                make_finding(
                    stage="diagnostics",
                    category="gbd_categories",
                    status="warning",
                    message=f"Non-GBD categories found: {non_gbd}",
                    count=len(non_gbd),
                    sample_values=non_gbd[:10],
                )
            )
        else:
            findings.append(
                make_finding(
                    stage="diagnostics",
                    category="gbd_categories",
                    status="success",
                    message="All categories are valid GBD categories.",
                )
            )

        if missing_gbd:
            findings.append(
                make_finding(
                    stage="diagnostics",
                    category="gbd_categories_absent",
                    status="info",
                    message=f"GBD categories absent from data: {missing_gbd}",
                    count=len(missing_gbd),
                )
            )

    if monthly_category_data is not None:
        findings.extend(check_zero_category_month_combos(monthly_category_data, metric_total))

    # Meat anomalies
    if "quantity" in df.columns and "category" in df.columns:
        meat_cats = get_meat_categories(lowercase=True)
        has_meat = df["category"].fillna("").astype(str).str.lower().isin(meat_cats).any()
        if has_meat:
            try:
                result = identify_potentially_abnormal_weight_meat_items(
                    df.copy(), "quantity", "category"
                )
                if isinstance(result, pd.DataFrame) and len(result) > 0:
                    large_quantity_threshold = float(result["large_quantity_threshold"].iloc[0])
                    findings.append(
                        make_finding(
                            stage="diagnostics",
                            category="meat_weights",
                            status="warning",
                            message=(
                                f"{len(result)} meat items have suspicious quantity values "
                                f"(fractional or > {large_quantity_threshold:g})."
                            ),
                            count=len(result),
                            metadata={"large_quantity_threshold": large_quantity_threshold},
                        )
                    )
                else:
                    findings.append(
                        make_finding(
                            stage="diagnostics",
                            category="meat_weights",
                            status="success",
                            message="No suspicious meat quantity values found.",
                        )
                    )
            except Exception as exc:
                findings.append(
                    make_finding(
                        stage="diagnostics",
                        category="meat_weights",
                        status="info",
                        message=f"Could not check meat weights: {exc}",
                    )
                )

    return findings


# ---------------------------------------------------------------------------
# Date parsing (moved from utils.py)
# ---------------------------------------------------------------------------

_MISSING_DATE_TOKENS = {"", "na", "n/a", "nan", "none", "null", "nat", "missing"}
_AMBIGUOUS_NUMERIC_DATE_PATTERN = re.compile(r"^\s*(\d{1,2})\D+(\d{1,2})\D+(\d{2}|\d{4})\s*$")


def _is_missing_date_value(value: Any) -> bool:
    """Return True when a value should be treated as a missing date."""
    if pd.isna(value):
        return True

    if isinstance(value, str):
        return value.strip().lower() in _MISSING_DATE_TOKENS

    return False


def _is_numeric_like(value: Any) -> bool:
    """Return True for numeric scalar values excluding booleans."""
    return isinstance(value, (int, float, np.integer, np.floating)) and not isinstance(value, bool)


def _is_ambiguous_numeric_date_string(value: str) -> bool:
    """
    Identify ambiguous day/month numeric date strings.

    Examples: 03/04/2025, 03-04-25, 03 04 2025.
    """
    match = _AMBIGUOUS_NUMERIC_DATE_PATTERN.match(value)
    if match is None:
        return False

    first = int(match.group(1))
    second = int(match.group(2))
    return 1 <= first <= 12 and 1 <= second <= 12


def _parse_numeric_date_value(value: float) -> tuple[pd.Timestamp | None, str | None]:
    """
    Parse numeric date encodings.

    Supports:
    - YYYYMMDD integers
    - Excel serial day numbers
    - Unix timestamps in seconds/ms/us/ns
    """
    if pd.isna(value):
        return None, None

    if float(value).is_integer():
        int_value = int(value)
        int_as_str = str(abs(int_value))
        if int_value > 0 and len(int_as_str) == 8:
            try:
                return pd.to_datetime(str(int_value), format="%Y%m%d"), "yyyymmdd_numeric"
            except ValueError, TypeError:
                pass

    abs_value = abs(float(value))

    try:
        if 20_000 <= abs_value <= 80_000:
            parsed = pd.Timestamp("1899-12-30") + pd.to_timedelta(float(value), unit="D")
            if not isinstance(parsed, pd.Timestamp):
                return None, None
            return parsed, "excel_serial"

        if 946_684_800 <= abs_value < 4_102_444_800:
            return pd.to_datetime(value, unit="s", origin="unix"), "unix_seconds"

        if 946_684_800_000 <= abs_value < 4_102_444_800_000:
            return pd.to_datetime(value, unit="ms", origin="unix"), "unix_milliseconds"

        if 946_684_800_000_000 <= abs_value < 4_102_444_800_000_000:
            return pd.to_datetime(value, unit="us", origin="unix"), "unix_microseconds"

        if 946_684_800_000_000_000 <= abs_value < 4_102_444_800_000_000_000:
            return pd.to_datetime(value, unit="ns", origin="unix"), "unix_nanoseconds"
    except OverflowError, ValueError:
        return None, None

    return None, None


def _normalize_date_boundary(
    value: str | date | datetime | pd.Timestamp,
) -> pd.Timestamp:
    """Normalize a configured date boundary and reject missing date values."""
    timestamp = pd.Timestamp(value)
    if not isinstance(timestamp, pd.Timestamp):
        raise ValueError(f"Date boundary cannot be missing: {value!r}")
    return timestamp.normalize()


def _build_date_parse_error_message(
    date_col: str,
    diagnostics: pd.DataFrame,
    allow_missing: bool,
) -> str:
    """Build a concise, actionable date parsing error message."""
    failing_statuses = ["ambiguous", "invalid", "missing", "out_of_range"]
    if allow_missing:
        failing_statuses = [status for status in failing_statuses if status != "missing"]

    failing = diagnostics[diagnostics["parse_status"].isin(failing_statuses)].copy()
    counts = failing["parse_status"].value_counts().to_dict()

    lines = [
        f"Date parsing failed for column '{date_col}'.",
        f"Issue counts: {counts}.",
    ]

    for status in ("ambiguous", "invalid", "missing", "out_of_range"):
        if status not in failing_statuses:
            continue
        status_rows = failing[failing["parse_status"] == status]
        if status_rows.empty:
            continue
        examples = status_rows["original_value"].astype(str).head(5).tolist()
        lines.append(f"- {status} examples: {examples}")

    lines.append(
        "Set `dayfirst_preference=True` or `False` to resolve ambiguous day/month ordering."
    )
    return "\n".join(lines)


@overload
def parse_and_validate_date_column(
    df: pd.DataFrame,
    date_col: str = "date",
    *,
    date_format: str | None = None,
    dayfirst_preference: bool | None = None,
    min_date: str | datetime | pd.Timestamp | None = None,
    max_date: str | datetime | pd.Timestamp | None = None,
    max_future_days: int = 30,
    allow_missing: bool = False,
    return_diagnostics: Literal[False] = False,
) -> pd.DataFrame: ...


@overload
def parse_and_validate_date_column(
    df: pd.DataFrame,
    date_col: str = "date",
    *,
    date_format: str | None = None,
    dayfirst_preference: bool | None = None,
    min_date: str | datetime | pd.Timestamp | None = None,
    max_date: str | datetime | pd.Timestamp | None = None,
    max_future_days: int = 30,
    allow_missing: bool = False,
    return_diagnostics: Literal[True],
) -> tuple[pd.DataFrame, pd.DataFrame]: ...


@overload
def parse_and_validate_date_column(
    df: pd.DataFrame,
    date_col: str = "date",
    *,
    date_format: str | None = None,
    dayfirst_preference: bool | None = None,
    min_date: str | datetime | pd.Timestamp | None = None,
    max_date: str | datetime | pd.Timestamp | None = None,
    max_future_days: int = 30,
    allow_missing: bool = False,
    return_diagnostics: bool,
) -> pd.DataFrame | tuple[pd.DataFrame, pd.DataFrame]: ...


def parse_and_validate_date_column(
    df: pd.DataFrame,
    date_col: str = "date",
    *,
    date_format: str | None = None,
    dayfirst_preference: bool | None = None,
    min_date: str | datetime | pd.Timestamp | None = None,
    max_date: str | datetime | pd.Timestamp | None = None,
    max_future_days: int = 30,
    allow_missing: bool = False,
    return_diagnostics: bool = False,
) -> pd.DataFrame | tuple[pd.DataFrame, pd.DataFrame]:
    """
    Parse and validate a date column using a strict multi-pass strategy.

    The function intentionally fails on ambiguous numeric dates by default
    (for example, ``03/04/2025``) unless ``dayfirst_preference`` is supplied.

    Parsing strategy:
    1. Exact custom format (if ``date_format`` is provided)
    2. Native datetime/date objects
    3. Numeric encodings (Excel serial, Unix timestamps, YYYYMMDD integers)
    4. Explicit common string formats
    5. dateutil fallback for remaining non-ambiguous strings
    6. Date range validation

    Returns:
        DataFrame with normalized datetime values in ``date_col``.
        If ``return_diagnostics=True``, also returns a diagnostics DataFrame with:
        ``original_value``, ``parsed_date``, ``parse_status``, and ``parser_used``.

    Raises:
        ValueError: If parsing fails, values are ambiguous, missing dates are disallowed,
                    or parsed values are out of allowed range.
    """
    if date_col not in df.columns:
        raise ValueError(f"Column '{date_col}' not found in DataFrame.")

    df_copy = df.copy()
    original = df_copy[date_col]

    parsed_dates = pd.Series(pd.NaT, index=df_copy.index, dtype="object")
    parse_status = pd.Series(pd.NA, index=df_copy.index, dtype="object")
    parser_used = pd.Series(pd.NA, index=df_copy.index, dtype="object")

    missing_mask = original.map(_is_missing_date_value)
    parse_status.loc[missing_mask] = "missing"
    parser_used.loc[missing_mask] = "missing"

    non_missing_mask = ~missing_mask
    if date_format is not None and non_missing_mask.any():
        strict_parsed = pd.to_datetime(
            original.loc[non_missing_mask],
            format=date_format,
            errors="coerce",
        )
        parsed_dates.loc[non_missing_mask] = strict_parsed
        strict_success = strict_parsed.notna()
        parse_status.loc[strict_success.index[strict_success]] = "parsed"
        parser_used.loc[strict_success.index[strict_success]] = f"format:{date_format}"
    else:
        # Pass 1: values already datetime-like
        datetime_like_mask = (
            original.map(
                lambda value: isinstance(value, (pd.Timestamp, datetime, date, np.datetime64))
            )
            & non_missing_mask
        )

        if datetime_like_mask.any():
            native_parsed = pd.to_datetime(
                original.loc[datetime_like_mask],
                errors="coerce",
            )
            parsed_dates.loc[datetime_like_mask] = native_parsed
            native_success = native_parsed.notna()
            parse_status.loc[native_success.index[native_success]] = "parsed"
            parser_used.loc[native_success.index[native_success]] = "native_datetime"

        # Pass 2: numeric encodings (Excel serial, unix, YYYYMMDD integer)
        remaining_mask = non_missing_mask & parsed_dates.isna()
        numeric_mask = original.map(_is_numeric_like) & remaining_mask
        if numeric_mask.any():
            for idx, value in original.loc[numeric_mask].items():
                parsed_value, parser_name = _parse_numeric_date_value(float(value))
                if pd.notna(parsed_value):
                    parsed_dates.at[idx] = parsed_value
                    parse_status.at[idx] = "parsed"
                    parser_used.at[idx] = parser_name

        # Pass 3: explicit string formats
        remaining_mask = non_missing_mask & parsed_dates.isna()
        string_mask = original.map(lambda value: isinstance(value, str)) & remaining_mask

        if string_mask.any():
            cleaned_strings = (
                original.loc[string_mask]
                .astype(str)
                .str.strip()
                .str.replace(r"(\d{1,2})(st|nd|rd|th)\b", r"\1", regex=True)  # codespell:ignore nd
                .str.replace(",", "", regex=False)
                .str.replace(r"\s+", " ", regex=True)
            )

            if dayfirst_preference is None:
                ambiguous_mask = cleaned_strings.map(_is_ambiguous_numeric_date_string)
            else:
                ambiguous_mask = pd.Series(False, index=cleaned_strings.index)

            if ambiguous_mask.any():
                ambiguous_indices = ambiguous_mask.index[ambiguous_mask]
                parse_status.loc[ambiguous_indices] = "ambiguous"
                parser_used.loc[ambiguous_indices] = "ambiguous_numeric_date"

            non_ambiguous_strings = cleaned_strings.loc[~ambiguous_mask]
            if dayfirst_preference is True:
                slash_dash_dot_formats = [
                    "%d/%m/%Y",
                    "%m/%d/%Y",
                    "%d-%m-%Y",
                    "%m-%d-%Y",
                    "%d.%m.%Y",
                    "%m.%d.%Y",
                    "%d/%m/%y",
                    "%m/%d/%y",
                    "%d-%m-%y",
                    "%m-%d-%y",
                ]
            else:
                slash_dash_dot_formats = [
                    "%m/%d/%Y",
                    "%d/%m/%Y",
                    "%m-%d-%Y",
                    "%d-%m-%Y",
                    "%m.%d.%Y",
                    "%d.%m.%Y",
                    "%m/%d/%y",
                    "%d/%m/%y",
                    "%m-%d-%y",
                    "%d-%m-%y",
                ]

            explicit_formats = [
                "%Y-%m-%d",
                "%Y/%m/%d",
                "%Y.%m.%d",
                "%Y %m %d",
                "%d %m %Y",
                "%Y%m%d",
                *slash_dash_dot_formats,
                "%d %b %Y",
                "%d %B %Y",
                "%b %d %Y",
                "%B %d %Y",
                "%d-%b-%Y",
                "%d-%B-%Y",
                "%b-%d-%Y",
                "%B-%d-%Y",
                "%d %b %y",
                "%d %B %y",
                "%b %d %y",
                "%B %d %y",
            ]

            for date_fmt in explicit_formats:
                still_unparsed = non_ambiguous_strings.index[
                    parsed_dates.loc[non_ambiguous_strings.index].isna()
                ]
                if len(still_unparsed) == 0:
                    break

                parsed = pd.to_datetime(
                    non_ambiguous_strings.loc[still_unparsed],
                    format=date_fmt,
                    errors="coerce",
                )
                parsed_success = parsed.notna()
                if not parsed_success.any():
                    continue

                success_idx = parsed_success.index[parsed_success]
                parsed_dates.loc[success_idx] = parsed.loc[success_idx]
                parse_status.loc[success_idx] = "parsed"
                parser_used.loc[success_idx] = f"format:{date_fmt}"

            # Pass 4: fallback parser (dateutil via pandas)
            fallback_mask = non_ambiguous_strings.index[
                parsed_dates.loc[non_ambiguous_strings.index].isna()
            ]
            if len(fallback_mask) > 0:
                fallback_parsed = pd.to_datetime(
                    non_ambiguous_strings.loc[fallback_mask],
                    errors="coerce",
                    dayfirst=False if dayfirst_preference is None else dayfirst_preference,
                )
                fallback_success = fallback_parsed.notna()
                if fallback_success.any():
                    success_idx = fallback_success.index[fallback_success]
                    parsed_dates.loc[success_idx] = fallback_parsed.loc[success_idx]
                    parse_status.loc[success_idx] = "parsed"
                    parser_used.loc[success_idx] = "dateutil_fallback"

    # Mark any remaining non-missing/unparsed rows as invalid.
    invalid_mask = non_missing_mask & parse_status.isna()
    parse_status.loc[invalid_mask] = "invalid"
    parser_used.loc[invalid_mask] = "none"

    # Normalize to date-only (midnight), dropping timezone info consistently.
    parsed_dates = (
        pd.to_datetime(parsed_dates, errors="coerce", utc=True).dt.tz_localize(None).dt.normalize()
    )

    min_date_ts = _normalize_date_boundary(min_date) if min_date is not None else None
    if max_date is not None:
        max_date_ts = _normalize_date_boundary(max_date)
    else:
        max_date_ts = _normalize_date_boundary(date.today() + timedelta(days=max_future_days))

    parsed_mask = parse_status == "parsed"
    if min_date_ts is not None:
        below_min = parsed_mask & (parsed_dates < min_date_ts)
        parse_status.loc[below_min] = "out_of_range"

    above_max = parsed_mask & (parsed_dates > max_date_ts)
    parse_status.loc[above_max] = "out_of_range"

    diagnostics_df = pd.DataFrame(
        {
            "original_value": original,
            "parsed_date": parsed_dates,
            "parse_status": parse_status,
            "parser_used": parser_used,
        },
        index=df_copy.index,
    )

    failing_statuses = {"ambiguous", "invalid", "out_of_range"}
    if not allow_missing:
        failing_statuses.add("missing")

    if diagnostics_df["parse_status"].isin(failing_statuses).any():
        raise ValueError(
            _build_date_parse_error_message(
                date_col=date_col,
                diagnostics=diagnostics_df,
                allow_missing=allow_missing,
            )
        )

    df_copy[date_col] = parsed_dates
    if return_diagnostics:
        return df_copy, diagnostics_df
    return df_copy
