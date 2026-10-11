"""Diagnostics only the lab's food-report bundle runs."""

from itertools import combinations
from typing import Any

import numpy as np
import pandas as pd
from gbd_foodservice_insights.categories import get_meat_categories
from gbd_foodservice_insights.report.quality import Finding, make_finding
from gbd_foodservice_insights.report.thresholds import (
    get_diagnostic_threshold,
    resolve_diagnostic_threshold,
)
from Levenshtein import distance


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


def check_meat_quantities(df: pd.DataFrame) -> list[Finding]:
    """Flag meat rows whose `quantity` looks like a total weight rather than a count.

    Only the lab's serving CSVs carry a `quantity` column, so this returns nothing for anything
    else.
    """
    findings: list[Finding] = []
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
