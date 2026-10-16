"""
Food Product Categorization — Orchestrator
============================================

Public entry point for categorization:

    categorize_unique_products() — categorize each unique product of already-typed rows
    summarize_categorization()   — count what that did, for telemetry

Callers merge the result back onto the rows with `steps.merge_categorizations`.

All helper logic lives in sibling modules:

    steps.py    — historical reuse, name cleaning, LLM categorization, merge-back
    cache.py    — the reviewed cache, which callers load and pass in
"""

import logging
from dataclasses import dataclass

import pandas as pd

from gbd_foodservice_insights.categorization.cache import NO_MATCHES_FOUND, CategorizationCache
from gbd_foodservice_insights.categorization.llm import LlmClient
from gbd_foodservice_insights.categorization.steps import (
    MATCH_TYPE_CLEANED,
    MATCH_TYPE_LLM,
    MATCH_TYPE_RAW,
    categorize_using_cleaned_name_history,
    categorize_using_historical_classifications,
    categorize_with_llm,
    clean_product_names,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CategorizedProducts:
    cleaned_df: pd.DataFrame  # the input rows, with product stripped
    unique_products_df: pd.DataFrame  # one row per product, with its category and match_type
    unrecognized_llm_answers: int  # per unique cleaned name sent to the LLM, not per product


@dataclass(frozen=True)
class NewCategorization:
    """A product the LLM categorized this run, as a suggestion for the cache."""

    product: str
    cleaned_name: str | None
    category: str  # "No Matches Found" included


@dataclass(frozen=True)
class CategorizationSummary:
    """The upload's unique products by how each was categorized, and the upload's rows that
    categorization left usable. The three match types partition the unique products."""

    cache_raw_name_products: int  # the cache had the product itself
    cache_cleaned_name_products: int  # the cache had its LLM-cleaned name
    llm_matched_products: int
    # "No Matches Found" from the cache, which counts as a hit, or from the LLM.
    cache_no_match_products: int
    llm_no_match_products: int
    unrecognized_llm_answers: int
    categorized_rows: int
    categorized_kilograms: float  # in the weight column's unit, which `analyze` makes kilograms


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
    unique_products_df, unrecognized_llm_answers = categorize_with_llm(unique_products_df, llm)

    # The cleaned-name reuse hit rate.
    logger.info(
        "Match-type breakdown (unique products): %s",
        unique_products_df["match_type"].value_counts().to_dict(),
    )

    return CategorizedProducts(
        cleaned_df=df,
        unique_products_df=unique_products_df,
        unrecognized_llm_answers=unrecognized_llm_answers,
    )


def summarize_categorization(categorized: CategorizedProducts) -> CategorizationSummary:
    """Reads only `categorize_unique_products`' frames, so it can run before
    `merge_categorizations` rejects them. The rows it counts as categorized are the ones that
    merge keeps."""
    match_type = categorized.unique_products_df["match_type"]
    known = match_type.isin([MATCH_TYPE_RAW, MATCH_TYPE_CLEANED, MATCH_TYPE_LLM])
    if not known.all():
        raise ValueError(f"Unknown match types: {sorted(set(match_type[~known].astype(str)))}")

    products_by_type = match_type.value_counts()
    uncategorized = categorized.unique_products_df["category"] == NO_MATCHES_FOUND
    from_llm = match_type == MATCH_TYPE_LLM

    row_category = categorized.cleaned_df["product"].map(
        categorized.unique_products_df.set_index("product")["category"]
    )
    # As in `merge_categorizations`: counted, not named, since product names are customer data.
    n_missing = row_category.isna().sum()
    if n_missing > 0:
        raise ValueError(
            f"No categorization for {n_missing} of {len(categorized.cleaned_df)} rows."
        )
    kept = row_category != NO_MATCHES_FOUND

    return CategorizationSummary(
        cache_raw_name_products=int(products_by_type.get(MATCH_TYPE_RAW, 0)),
        cache_cleaned_name_products=int(products_by_type.get(MATCH_TYPE_CLEANED, 0)),
        llm_matched_products=int(products_by_type.get(MATCH_TYPE_LLM, 0)),
        cache_no_match_products=int((uncategorized & ~from_llm).sum()),
        llm_no_match_products=int((uncategorized & from_llm).sum()),
        unrecognized_llm_answers=categorized.unrecognized_llm_answers,
        categorized_rows=int(kept.sum()),
        categorized_kilograms=float(categorized.cleaned_df.loc[kept, "weight"].sum()),
    )
