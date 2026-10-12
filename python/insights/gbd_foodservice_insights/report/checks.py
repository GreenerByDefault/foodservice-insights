"""Data quality checks and anomaly detection for food reports."""

import logging
from collections.abc import Mapping

import numpy as np
import pandas as pd

from gbd_foodservice_insights.report.metric import KILOS, Metric
from gbd_foodservice_insights.report.quality import Finding, make_finding
from gbd_foodservice_insights.report.schema import DinerOrMeal
from gbd_foodservice_insights.report.thresholds import get_diagnostic_threshold

logger = logging.getLogger(__name__)


def _format_quantity(value: float, metric: Metric) -> str:
    # Below 0.01, two significant figures: a fixed two decimals would print the tiny weights
    # the bounds check exists to catch as 0.
    if 0 < abs(value) < 0.01:
        number = np.format_float_positional(value, precision=2, fractional=False)
    else:
        number = f"{value:,.2f}".rstrip("0").rstrip(".")
    return f"{number} {metric.unit_singular if number == '1' else metric.unit_plural}"


def _format_line_count(count: int) -> str:
    return f"{count:,} line{'' if count == 1 else 's'}"


def detect_unusual_sales(
    df: pd.DataFrame,
    metric: Metric,
    product_name_col: str,
    *,
    category_col: str = "category",
    sample_limit: int = 5,
) -> tuple[list[Finding], pd.DataFrame]:
    """Flag unusually large line items before bad rows distort totals and trends.

    This exists to catch row-level values that are implausibly high for their
    category and are more likely to be entry, unit, or OCR mistakes than real
    purchasing behaviour. Category-level medians and MAD keep the baseline
    robust to skewed data, while ratio-based fallbacks still catch obvious
    extremes in categories with very low spread.
    """
    threshold = get_diagnostic_threshold("outlier_line_items", "mad_threshold")
    min_category_rows = max(
        int(get_diagnostic_threshold("outlier_line_items", "min_category_rows")), 1
    )
    warning_share_threshold = get_diagnostic_threshold(
        "outlier_line_items", "warning_share_threshold"
    )
    extreme_ratio_threshold = get_diagnostic_threshold(
        "outlier_line_items", "extreme_ratio_threshold"
    )
    zero_mad_ratio_threshold = get_diagnostic_threshold(
        "outlier_line_items", "zero_mad_ratio_threshold"
    )
    small_category_ratio_threshold = get_diagnostic_threshold(
        "outlier_line_items", "small_category_ratio_threshold"
    )

    no_outliers = [
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

    working = df.copy()
    working["_row_index"] = working.index
    working["_metric_value"] = working[metric.column]

    valid_rows = working[working["_metric_value"] > 0].copy()

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
        return no_outliers, pd.DataFrame()

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
    sample_values = [
        (
            f"{row[product_name_col]} in {row[category_col]}: "
            f"{_format_quantity(row['_metric_value'], metric)}, "
            f"{row['ratio_to_category_median']:.1f}x the category's typical line of "
            f"{_format_quantity(row['category_median'], metric)}."
        )
        for _, row in flagged_rows.head(sample_limit).iterrows()
    ]

    findings = [
        make_finding(
            stage="diagnostics",
            category="outlier_line_items",
            status=status,
            message=(
                f"Found {_format_line_count(outlier_row_count)} far larger than is typical for "
                f"{'its' if outlier_row_count == 1 else 'their'} category "
                f"({outlier_row_share:.2%} of all lines). The largest is "
                f"{top_row[product_name_col]} in {top_row[category_col]} at "
                f"{_format_quantity(top_row['_metric_value'], metric)}, "
                f"{top_row['ratio_to_category_median']:.1f}x that category's typical line of "
                f"{_format_quantity(top_row['category_median'], metric)}. Lines like these "
                "are often a unit or entry mistake."
            ),
            column=metric.column,
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
            },
        )
    ]

    export_columns = [
        "_row_index",
        "date",
        product_name_col,
        category_col,
        metric.column,
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
    metric: Metric,
    low: float,
    high: float,
    sample_limit: int = 20,
) -> tuple[list[Finding], pd.DataFrame]:
    """Flag line items with weights outside the hard bounds used for unit-error QA.

    This exists to catch near-certain unit mistakes that are easy to explain and
    review. Unlike the category-relative outlier check, these absolute limits do
    not depend on distribution shape and are intended for obviously implausible
    single-row transaction weights.
    """
    subject_label = f"per-product {metric.line_noun}s"

    if low > high:
        raise ValueError(f"Per-product weight bounds must satisfy low <= high; got {low} > {high}.")

    working = df.copy()
    working["_row_index"] = working.index
    working["_metric_value"] = working[metric.column]

    # A zero line is ordinary data, not a unit mistake: the report counts it like any other.
    flagged_rows = working.loc[
        ((working["_metric_value"] > 0) & (working["_metric_value"] < low))
        | (working["_metric_value"] > high)
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
            pd.DataFrame(columns=["row_index", "product", metric.column, "breached_bound"]),
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
    # Most extreme first on each side, so the examples are the lines least likely to be real.
    flagged_rows = (
        flagged_rows.assign(
            _extremity=np.where(
                flagged_rows["breached_bound"] == "lower",
                flagged_rows["_metric_value"],
                -flagged_rows["_metric_value"],
            )
        )
        .sort_values(["breached_bound", "_extremity", "_row_index"])
        .drop(columns="_extremity")
    )

    def describe(row: pd.Series) -> str:
        side = "below the lower" if row["breached_bound"] == "lower" else "above the upper"
        return (
            f"{row['product']} at {_format_quantity(row['_metric_value'], metric)}, "
            f"{side} bound of {_format_quantity(row['breached_threshold'], metric)}."
        )

    sample_values = [describe(row) for _, row in flagged_rows.head(sample_limit).iterrows()]

    findings = [
        make_finding(
            stage="diagnostics",
            category="per_product_weight_bounds",
            status="warning",
            message=(
                f"Found {_format_line_count(len(flagged_rows))} with a {metric.line_noun} above "
                f"zero but under {_format_quantity(low, metric)}, or over "
                f"{_format_quantity(high, metric)}, which usually means a unit mistake. "
                f"For example, {describe(flagged_rows.iloc[0])}"
            ),
            column=metric.column,
            count=len(flagged_rows),
            sample_values=sample_values,
            metadata={
                "low": low,
                "high": high,
                "unit_label": metric.unit_plural,
                "flagged_row_count": len(flagged_rows),
            },
        )
    ]

    export_columns = [
        "_row_index",
        "date",
        "product",
        "category",
        metric.column,
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


def detect_month_over_month_total_volatility(
    df: pd.DataFrame,
    metric: Metric,
    *,
    month_col: str = "month_year",
    sample_limit: int = 6,
) -> list[Finding]:
    """Flag sudden monthly total swings before users trust a misleading trend.

    This exists because large month-to-month changes are often caused by
    missing uploads, partial months, or duplicated data rather than a real
    operational shift. Surfacing those jumps gives catering managers a simple
    continuity check before they read the rest of the report.
    """
    monthly_totals = (
        df.dropna(subset=[month_col])
        .groupby(month_col, dropna=False)[metric.column]
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

    def describe(row: pd.Series) -> str:
        # A rise from zero has no percentage; the two totals already say what happened.
        change = "" if np.isinf(row["pct_change"]) else f" ({row['pct_change']:+.0%})"
        return (
            f"{_format_month_label(row[month_col])}: "
            f"{_format_quantity(row['current_total'], metric)} against "
            f"{_format_quantity(row['previous_total'], metric)} in "
            f"{_format_month_label(row['previous_month'])}{change}."
        )

    sample_values = [describe(row) for _, row in volatile_months.head(sample_limit).iterrows()]

    findings = [
        make_finding(
            stage="diagnostics",
            category="month_over_month_total_volatility",
            status="warning",
            message=(
                f"Found {len(volatile_months)} month{'' if len(volatile_months) == 1 else 's'} "
                f"where the total {metric.label.lower()} changed by more "
                f"than {change_threshold:.0%} from the month before. Large swings like this "
                "often mean a month is missing, partial, or counted twice."
            ),
            column=metric.column,
            count=len(volatile_months),
            sample_values=sample_values,
            metadata={"warning_pct_change_threshold": change_threshold},
        )
    ]
    return findings


def _format_month_label(month: pd.Period) -> str:
    return month.strftime("%b %Y")


def _describe_unmatched_count(
    month_label: str,
    count: float,
    count_ratio: float,
    median_count: float,
    diner_or_meal: DinerOrMeal,
) -> str:
    noun = diner_or_meal if count == 1 else f"{diner_or_meal}s"
    change = "rise" if count_ratio > 1 else "drop"
    return (
        f"{month_label}: {count:,.0f} {noun}, against {median_count:,.0f} in a typical month, "
        f"with no matching {change} in food."
    )


def check_diner_meal_reasonableness(
    df: pd.DataFrame,
    diner_meal_mapping: Mapping[pd.Period, float],
    metric_total: str,
    *,
    diner_or_meal: DinerOrMeal,
    sample_limit: int = 6,
) -> tuple[list[Finding], pd.DataFrame]:
    """Flag months whose diner or meal count looks mistyped, which would make that month's
    per-diner and per-meal figures wrong. Expects `month_year` as `Period[M]`."""
    low_threshold = get_diagnostic_threshold(
        "diner_meal_count_reasonableness", "low_ratio_threshold"
    )
    high_threshold = get_diagnostic_threshold(
        "diner_meal_count_reasonableness", "high_ratio_threshold"
    )
    thresholds = {"low_ratio_threshold": low_threshold, "high_ratio_threshold": high_threshold}

    counts = pd.Series(diner_meal_mapping, dtype="float64")
    # Only months with both a count and rows have a per-diner figure. Rows without a count already
    # failed aggregation; a count without rows is a month the customer bought nothing in.
    monthly = pd.concat(
        [
            counts[counts > 0].rename("diner_meal_count"),
            df.groupby("month_year")[metric_total].sum().rename("food_total"),
        ],
        axis=1,
        join="inner",
    ).sort_index()
    monthly["food_per_count"] = monthly["food_total"] / monthly["diner_meal_count"]
    median_count = float(monthly["diner_meal_count"].median())
    median_food_per_count = float(monthly["food_per_count"].median())

    if monthly.empty or not median_food_per_count > 0:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="diner_meal_count_reasonableness",
                    status="info",
                    message=(
                        f"Could not check the {diner_or_meal} counts for typos, because no "
                        "month has both a count and food in the file."
                    ),
                    count=0,
                    metadata=thresholds,
                )
            ],
            pd.DataFrame(),
        )

    count_ratio = monthly["diner_meal_count"] / median_count
    food_per_count_ratio = monthly["food_per_count"] / median_food_per_count
    # A count far from the usual is not enough: a school's summer counts can fall to 30% of term
    # time, and its purchases with them. A mistyped count moves alone, so food per head swings
    # the other way. Food that swings with an ordinary count is month volatility, not this.
    count_too_high = count_ratio.gt(high_threshold) & food_per_count_ratio.lt(low_threshold)
    count_too_low = count_ratio.lt(low_threshold) & food_per_count_ratio.gt(high_threshold)

    qc_df = pd.DataFrame(
        {
            "month_year": monthly.index.astype(str),
            "month_label": [_format_month_label(month) for month in monthly.index],
            "diner_meal_count": monthly["diner_meal_count"].to_numpy(),
            "food_total": monthly["food_total"].to_numpy(),
            "food_per_count": monthly["food_per_count"].to_numpy(),
            "count_ratio_to_median": count_ratio.to_numpy(),
            "food_per_count_ratio_to_median": food_per_count_ratio.to_numpy(),
            "is_flagged": (count_too_high | count_too_low).to_numpy(),
            "flag_reason": np.select(
                [count_too_high.to_numpy(), count_too_low.to_numpy()],
                [
                    (
                        "Count far above a typical month with no matching rise in food: "
                        f"per-{diner_or_meal} figures look too low."
                    ),
                    (
                        "Count far below a typical month with no matching drop in food: "
                        f"per-{diner_or_meal} figures look too high."
                    ),
                ],
                default="",
            ),
        }
    )
    metadata = {
        "metric_col": metric_total,
        "median_count": median_count,
        "median_food_per_count": median_food_per_count,
        **thresholds,
    }

    flagged_df = qc_df[qc_df["is_flagged"]]
    flagged_count = len(flagged_df)
    if flagged_count == 0:
        return (
            [
                make_finding(
                    stage="diagnostics",
                    category="diner_meal_count_reasonableness",
                    status="success",
                    message=(
                        f"No month's {diner_or_meal} count looks out of line with the food in "
                        "the file."
                    ),
                    count=0,
                    metadata=metadata,
                )
            ],
            qc_df,
        )

    sample_values = [
        _describe_unmatched_count(
            row["month_label"],
            row["diner_meal_count"],
            row["count_ratio_to_median"],
            median_count,
            diner_or_meal,
        )
        for _, row in flagged_df.head(sample_limit).iterrows()
    ]

    # A finished report's counts cannot be edited in the web app; the fix is a new report.
    if flagged_count == 1:
        message = (
            f"The {diner_or_meal} count entered for one month is far higher or lower than in a "
            "typical month, but the food in the file did not rise or fall with it. That can "
            f"mean a typo, which would make that month's per-{diner_or_meal} figures wrong. If "
            "the count is wrong, create a new report with the same file and the corrected count."
        )
    else:
        message = (
            f"The {diner_or_meal} counts entered for {flagged_count} months are far higher or "
            "lower than in a typical month, but the food in the file did not rise or fall with "
            "them. That can mean a typo, which would make that month's "
            f"per-{diner_or_meal} figures wrong. If a count is wrong, create a new report with "
            "the same file and the corrected count."
        )

    findings = [
        make_finding(
            stage="diagnostics",
            category="diner_meal_count_reasonableness",
            # Never an error: a flagged count is still one the user typed, and may be right.
            status="warning",
            message=message,
            count=flagged_count,
            sample_values=sample_values,
            metadata=metadata,
        )
    ]
    return findings, qc_df


def check_missing_internal_months(
    df: pd.DataFrame,
    *,
    month_col: str = "month_year",
) -> list[Finding]:
    """Flag fully missing months before short report windows are misread as complete.

    This exists because a missing internal month can distort averages, trends,
    and period comparisons substantially, especially in the common three-month
    reporting window where one absent month means a third of the expected period
    is missing.
    """
    observed_months = df[month_col].dropna().sort_values().unique()

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


def check_date_distribution(df: pd.DataFrame) -> list[Finding]:
    """Check if first/last months look partial based on row count."""
    findings: list[Finding] = []

    month_counts = df.groupby("month_year", dropna=False).size().sort_index()
    if len(month_counts) < 3:
        return findings

    partial_month_ratio_threshold = get_diagnostic_threshold(
        "date_distribution",
        "partial_month_ratio_threshold",
    )
    median_count = month_counts.iloc[1:-1].median()

    for label, idx in [("first", 0), ("last", -1)]:
        count = month_counts.iloc[idx]
        ratio = count / median_count
        if ratio < partial_month_ratio_threshold:
            findings.append(
                make_finding(
                    stage="diagnostics",
                    category="date_distribution",
                    status="warning",
                    message=(
                        f"{_format_month_label(month_counts.index[idx])}, the {label} month in "
                        f"the file, has {_format_line_count(int(count))} against about "
                        f"{median_count:,.0f} in a typical month, so it may be a partial month."
                    ),
                    count=int(count),
                    metadata={"partial_month_ratio_threshold": partial_month_ratio_threshold},
                )
            )

    return findings


def run_all_diagnostics(
    df: pd.DataFrame,
    diner_meal_mapping: Mapping[pd.Period, float],
    diner_or_meal: DinerOrMeal,
) -> list[Finding]:
    """Run report diagnostics on rows whose `month_year` is already `Period[M]`."""
    findings: list[Finding] = []
    findings.extend(detect_month_over_month_total_volatility(df, KILOS))
    findings.extend(check_missing_internal_months(df))
    denominator_reasonableness_findings, _ = check_diner_meal_reasonableness(
        df, diner_meal_mapping, KILOS.column, diner_or_meal=diner_or_meal
    )
    findings.extend(denominator_reasonableness_findings)
    unusual_sales_findings, _ = detect_unusual_sales(
        df,
        KILOS,
        product_name_col="product",
        category_col="category",
    )
    findings.extend(unusual_sales_findings)
    per_product_weight_bound_findings, _ = check_per_product_weight_bounds(
        df,
        KILOS,
        low=get_diagnostic_threshold("per_product_weight_bounds", "low"),
        high=get_diagnostic_threshold("per_product_weight_bounds", "high"),
    )
    findings.extend(per_product_weight_bound_findings)
    findings.extend(check_date_distribution(df))
    return findings
