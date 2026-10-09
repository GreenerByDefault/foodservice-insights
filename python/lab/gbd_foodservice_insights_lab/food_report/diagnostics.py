"""Diagnostics only the lab's food-report bundle runs."""

import numpy as np
import pandas as pd
from gbd_foodservice_insights.categories import get_meat_categories
from gbd_foodservice_insights.report.quality import Finding, make_finding
from gbd_foodservice_insights.report.thresholds import get_diagnostic_threshold


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
