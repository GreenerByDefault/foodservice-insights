"""
Food Product Categorization — Orchestrator
============================================

Public entry point for categorization:

    categorize_unique_products() — categorize each unique product of already-typed rows

Callers merge the result back onto the rows with `steps.merge_categorizations`.

All helper logic lives in sibling modules:

    steps.py    — historical reuse, name cleaning, LLM categorization, merge-back
    reviews.py  — human-review table construction
    cache.py    — the reviewed cache, which callers load and pass in
"""

import logging
from dataclasses import dataclass

import pandas as pd

from gbd_foodservice_insights.categorization.cache import CategorizationCache
from gbd_foodservice_insights.categorization.llm import LlmClient
from gbd_foodservice_insights.categorization.reviews import build_ai_review_table
from gbd_foodservice_insights.categorization.steps import (
    categorize_using_cleaned_name_history,
    categorize_using_historical_classifications,
    categorize_with_llm,
    clean_product_names,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CategorizedProducts:
    cleaned_df: pd.DataFrame  # the input rows, with product stripped
    unique_products_df: pd.DataFrame  # one row per product, with its category
    ai_review_df: pd.DataFrame  # the products an LLM categorized, for human review
    match_type_counts: dict[str, int]


# ----------------------------------------------------------------------
# Main pipeline
# ----------------------------------------------------------------------
def categorize_unique_products(
    df: pd.DataFrame,
    llm: LlmClient,
    cache: CategorizationCache,
) -> CategorizedProducts:
    """Assign a GBD emissions category to each unique product.

    `df` needs `str` product, `datetime64` date and numeric weight columns with no missing values:
    a wrong dtype raises `TypeError`, a missing column or value `ValueError`.
    """
    for col in ("product", "date", "weight"):
        if col not in df.columns:
            raise ValueError(f"Column '{col}' not found in DataFrame.")
    if not pd.api.types.is_string_dtype(df["product"]):
        raise TypeError(f"product must be str, not {df['product'].dtype}")
    if not pd.api.types.is_datetime64_dtype(df["date"]):
        raise TypeError(f"date must be datetime64, not {df['date'].dtype}")
    if not pd.api.types.is_numeric_dtype(df["weight"]):
        raise TypeError(f"weight must be numeric, not {df['weight'].dtype}")
    for col in ("product", "date", "weight"):
        if df[col].isna().any():
            raise ValueError(f"Column '{col}' contains missing values.")

    # Stripping is the cache's match-key rule (`CategorizationCache.from_frame` strips too).
    df = df.assign(product=df["product"].str.strip())

    # --- Match against historical categorizations ---
    unique_products_df = df[["product"]].drop_duplicates().copy()

    unique_products_df = categorize_using_historical_classifications(unique_products_df, cache)

    # --- Clean product names for uncategorized items ---
    unique_products_df = clean_product_names(unique_products_df, llm)

    # --- Reuse categories for recognised cleaned names ---
    unique_products_df = categorize_using_cleaned_name_history(unique_products_df, cache)

    # --- LLM categorization for still-uncategorized items ---
    unique_products_df = categorize_with_llm(unique_products_df, llm)

    # Build human-review table for AI-only categorizations
    ai_review_df = build_ai_review_table(
        original_df=df,
        unique_products_df=unique_products_df,
    )

    # Provenance breakdown (raw-history / cleaned-name-history / llm) for the
    # cleaned-name reuse hit-rate. Cast to plain str/int so the summary stays
    # JSON-serialisable for the report manifest.
    match_type_counts = {
        str(k): int(v)
        for k, v in unique_products_df["match_type"].fillna("unknown").value_counts().items()
    }
    logger.info("Match-type breakdown (unique products): %s", match_type_counts)

    return CategorizedProducts(
        cleaned_df=df,
        unique_products_df=unique_products_df,
        ai_review_df=ai_review_df,
        match_type_counts=match_type_counts,
    )
