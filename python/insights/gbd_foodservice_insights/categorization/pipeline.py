"""
Food Product Categorization — Orchestrator
============================================

Public entry point for categorization:

    categorize_unique_products() — clean the input and categorize each unique product

Callers merge the result back onto the rows with `steps.merge_categorizations`.

All helper logic lives in sibling modules:

    steps.py    — historical reuse, name cleaning, LLM categorization,
                 fuzzy matching, merge-back
    reviews.py  — human-review table construction
    cache.py    — reviewed/unreviewed cache persistence, promotion
"""

import logging
from dataclasses import dataclass
from typing import Literal

import pandas as pd

from gbd_foodservice_insights.categories import check_GBD_categories
from gbd_foodservice_insights.categorization.cache import (
    _validate_cache_write_mode,
    build_cleaned_name_reuse_index,
    get_previously_categorized_items,
    save_historical_categorizations,
    save_unreviewed_web_app_categorizations,
)
from gbd_foodservice_insights.categorization.llm import LlmClient
from gbd_foodservice_insights.categorization.reviews import build_ai_review_table
from gbd_foodservice_insights.categorization.steps import (
    categorize_using_cleaned_name_history,
    categorize_using_historical_classifications,
    categorize_with_llm,
    clean_product_names,
    fuzzy_match_GBD_categories,
)
from gbd_foodservice_insights.report.diagnostics import (
    clean_weight_column,
    parse_and_validate_date_column,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CategorizedProducts:
    cleaned_df: pd.DataFrame  # the input rows, with product, date and weight cleaned
    unique_products_df: pd.DataFrame  # one row per product, with its category
    ai_review_df: pd.DataFrame  # the products an LLM categorized, for human review
    match_type_counts: dict[str, int]


# ----------------------------------------------------------------------
# Main pipeline
# ----------------------------------------------------------------------
def categorize_unique_products(
    df: pd.DataFrame,
    llm: LlmClient,
    historical_categorizations: pd.DataFrame | None = None,
    cache_write_mode: Literal["none", "reviewed", "web_app_unreviewed"] = "none",
    date_format: str | None = None,
) -> CategorizedProducts:
    """Clean the input and assign a GBD emissions category to each unique product.

    `df` needs product, date, and weight columns. Reads the packaged category cache when
    `historical_categorizations` is None. `cache_write_mode` picks where new categorizations
    are appended: "none" (nowhere), "reviewed" (the reviewed historical cache), or
    "web_app_unreviewed" (the unreviewed web-app cache). `date_format=None` auto-detects the
    date format.
    """
    cache_write_mode = _validate_cache_write_mode(cache_write_mode)

    # --- Validate required columns ---
    for col in ("product", "date", "weight"):
        if col not in df.columns:
            raise ValueError(f"Column '{col}' not found in DataFrame.")

    df = df.copy()

    # --- Clean input data ---
    df["product"] = df["product"].astype(str).str.strip()

    df = parse_and_validate_date_column(
        df=df,
        date_col="date",
        date_format=date_format,
        allow_missing=False,
    )
    df = clean_weight_column(df, "weight")

    if df["product"].isna().any():
        raise ValueError("Column 'product' contains NaN values after cleaning.")
    if df["weight"].isna().any():
        raise ValueError("Column 'weight' contains NaN values after cleaning.")
    if df["date"].isna().any():
        raise ValueError("Column 'date' contains NaN values after cleaning.")

    # --- Step 1: Match against historical categorizations ---
    unique_products_df = df[["product"]].drop_duplicates().copy()

    if historical_categorizations is None:
        historical_categorizations = get_previously_categorized_items()

    unique_products_df = categorize_using_historical_classifications(
        unique_products_df, historical_categorizations
    )

    # --- Step 2: Clean product names for uncategorized items ---
    unique_products_df = clean_product_names(unique_products_df, llm)

    # --- Step 2.5: Reuse categories for recognised cleaned names ---
    cleaned_name_reuse_index = build_cleaned_name_reuse_index(
        reviewed_df=historical_categorizations
    )
    unique_products_df = categorize_using_cleaned_name_history(
        unique_products_df, reuse_index=cleaned_name_reuse_index
    )

    # --- Step 3: LLM categorization for still-uncategorized items ---
    unique_products_df = categorize_with_llm(unique_products_df, llm)

    # --- Step 4: Normalize categories (fuzzy match non-standard ones) ---
    unique_products_df = fuzzy_match_GBD_categories(unique_products_df, llm)

    check_GBD_categories(unique_products_df)

    # Build human-review table for AI-only categorizations
    ai_review_df = build_ai_review_table(
        original_df=df,
        unique_products_df=unique_products_df,
        include_no_matches=True,
    )

    # --- Update historical cache ---
    if cache_write_mode == "reviewed":
        save_historical_categorizations(unique_products_df)
    elif cache_write_mode == "web_app_unreviewed":
        save_unreviewed_web_app_categorizations(unique_products_df)
    else:
        logger.info("Category cache writes disabled (cache_write_mode='none').")

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
