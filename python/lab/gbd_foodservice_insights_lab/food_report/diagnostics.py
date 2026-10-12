"""Diagnostics only the lab's food-report bundle runs."""

from datetime import timedelta
from itertools import combinations, pairwise
from typing import Any

import numpy as np
import pandas as pd
from gbd_foodservice_insights.report.quality import Finding, make_finding
from Levenshtein import distance

from gbd_foodservice_insights_lab.categories import meat_categories
from gbd_foodservice_insights_lab.food_report.thresholds import get_diagnostic_threshold


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


def identify_potentially_abnormal_weight_meat_items(
    df: pd.DataFrame,
    quantity_col: str = "quantity",
    category_col: str = "category",
) -> pd.DataFrame | bool:
    """Identify meat rows with suspicious quantities or fractional counts."""
    out = df.copy()
    out[quantity_col] = pd.to_numeric(out[quantity_col], errors="coerce")
    meats = {c.lower() for c in meat_categories()}
    large_quantity_threshold = get_diagnostic_threshold(
        "meat_quantity_reasonableness",
        "large_quantity_threshold",
    )

    if not out[category_col].fillna("").astype(str).str.lower().isin(meats).any():
        raise AssertionError("No rows found where category is in meat categories.")

    out["has_decimal"] = (~(out[quantity_col] % 1 == 0)).astype("boolean")
    out["over_large_quantity_threshold"] = (out[quantity_col] > large_quantity_threshold).astype(
        "boolean"
    )
    out["quantity_may_indicate_total_weight"] = (
        out["has_decimal"] | out["over_large_quantity_threshold"]
    ).astype("boolean")

    out["large_quantity_threshold"] = large_quantity_threshold
    mask_meat = out[category_col].fillna("").astype(str).str.lower().isin(meats)
    out.loc[
        ~mask_meat,
        ["has_decimal", "over_large_quantity_threshold", "quantity_may_indicate_total_weight"],
    ] = pd.NA

    flagged = out.loc[out["quantity_may_indicate_total_weight"].fillna(False)]
    if flagged.empty:
        return True
    return flagged


def check_meat_quantities(df: pd.DataFrame) -> list[Finding]:
    """Flag meat rows whose `quantity` looks like a total weight rather than a count.

    Only the lab's serving CSVs carry a `quantity` column, so this returns nothing for anything
    else.
    """
    findings: list[Finding] = []
    if "quantity" in df.columns and "category" in df.columns:
        meat_cats = [c.lower() for c in meat_categories()]
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

    if max_levenshtein_distance is None:
        max_levenshtein_distance = int(
            get_diagnostic_threshold("near_duplicate_product_names", "max_levenshtein_distance")
        )
    max_levenshtein_distance = max(max_levenshtein_distance, 0)

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
) -> tuple[list[Finding], pd.DataFrame]:
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


def _format_month_label(value: Any) -> str:
    return pd.Period(str(value), freq="M").strftime("%b %Y")


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


def _check_top_share_concentration(
    df: pd.DataFrame,
    metric_col: str,
    *,
    group_col: str,
    diagnostic_name: str,
    threshold_key: str,
    subject_label: str,
) -> list[Finding]:
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

    threshold_pct = max(get_diagnostic_threshold(diagnostic_name, threshold_key), 0.0)

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
) -> list[Finding]:
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
    )


def check_category_concentration(
    df: pd.DataFrame,
    metric_col: str,
    *,
    category_col: str = "category",
) -> list[Finding]:
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
    sample_limit: int = 6,
) -> list[Finding]:
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
        int(get_diagnostic_threshold("missing_weeks_within_month", "max_gap_days")), 1
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
            metadata={"max_gap_days": max_gap_days},
        )
    ]


def detect_category_discontinuity(
    df: pd.DataFrame,
    metric_total: str,
    *,
    category_col: str = "category",
    month_col: str = "month_year",
    sample_limit: int = 6,
) -> tuple[list[Finding], pd.DataFrame]:
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

    working = df.copy()
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
            metadata={"min_gap_months": min_gap_months},
        )
    ]

    export_df = discontinuity_df.assign(
        last_month_with_data=lambda x: x["last_month_with_data"].astype(str),
        first_month_back_with_data=lambda x: x["first_month_back_with_data"].astype(str),
    )
    return findings, export_df


def category_highest_vs_lowest_months(
    monthly_category_data: pd.DataFrame,
    metric_col: str,
) -> pd.DataFrame:
    """Calculate highest-to-lowest month ratio per category."""
    if metric_col not in monthly_category_data.columns:
        raise ValueError(f"Metric column '{metric_col}' not found in DataFrame.")

    results: list[dict[str, Any]] = []
    for category, cat_data in monthly_category_data.groupby("category", dropna=False):
        values = cat_data[metric_col].dropna()
        if values.empty:
            continue
        max_val = values.max()
        min_val = values.min()
        if min_val == 0:  # noqa: SIM108  # the nested conditional expression reads worse
            times_higher = float("inf") if max_val > 0 else 1.0
        else:
            times_higher = max_val / min_val

        if times_higher >= 2:
            results.append({"category": category, "times_higher": times_higher})

    if not results:
        return pd.DataFrame(columns=["category", "times_higher"])

    return pd.DataFrame(results).sort_values("times_higher", ascending=False).round(1)
