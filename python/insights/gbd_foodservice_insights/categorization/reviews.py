"""
Categorization Review Tables
==============================

Human-review table construction for AI categorizations.
"""

import pandas as pd


def build_ai_review_table(
    original_df: pd.DataFrame,
    unique_products_df: pd.DataFrame,
    include_no_matches: bool = True,
) -> pd.DataFrame:
    """Build a product-level human-review table for AI-categorized items only.

    `original_df` is the cleaned input rows, with a 'product' column; `unique_products_df` needs
    'product', 'category', and 'previously_categorized'.

    The returned table has columns 'category', 'product', and 'occurrence_count', sorted by
    category ASC, occurrence_count DESC, product ASC.
    """
    required_original_cols = {"product"}
    required_unique_cols = {"product", "category", "previously_categorized"}

    missing_original = required_original_cols - set(original_df.columns)
    if missing_original:
        raise ValueError(f"original_df missing required columns: {sorted(missing_original)}")

    missing_unique = required_unique_cols - set(unique_products_df.columns)
    if missing_unique:
        raise ValueError(f"unique_products_df missing required columns: {sorted(missing_unique)}")

    product_counts = (
        original_df["product"]
        .value_counts()
        .rename("occurrence_count")
        .to_frame()
        .reset_index()
        .rename(columns={"index": "product"})
    )

    ai_only = unique_products_df.loc[
        ~unique_products_df["previously_categorized"].fillna(False),
        ["product", "category"],
    ].copy()

    if not include_no_matches:
        ai_only = ai_only.loc[ai_only["category"] != "No Matches Found"]

    ai_review_df = ai_only.merge(product_counts, on="product", how="left")
    ai_review_df["occurrence_count"] = ai_review_df["occurrence_count"].fillna(0).astype(int)

    ai_review_df = ai_review_df[["category", "product", "occurrence_count"]]
    ai_review_df = ai_review_df.sort_values(
        by=["category", "occurrence_count", "product"],
        ascending=[True, False, True],
    ).reset_index(drop=True)

    return ai_review_df
