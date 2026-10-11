"""
Categorization Steps
=====================

Non-entree categorization steps: historical reuse, name cleaning,
LLM categorization, and merge-back.
"""

import logging
from collections import Counter
from dataclasses import dataclass
from typing import Any

import pandas as pd

from gbd_foodservice_insights.categories import category_names
from gbd_foodservice_insights.categorization.cache import (
    NO_MATCHES_FOUND,
    CategorizationCache,
    normalize_product_name,
)
from gbd_foodservice_insights.categorization.llm import LLM_CONCURRENCY, LlmClient
from gbd_foodservice_insights.errors import UnusableDataError
from gbd_foodservice_insights.utils import map_concurrently

MATCH_TYPE_RAW = "raw_product_history"
MATCH_TYPE_CLEANED = "cleaned_name_history"
MATCH_TYPE_LLM = "llm"

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# Historical reuse
# ----------------------------------------------------------------------
def categorize_using_historical_classifications(
    unique_products_df: pd.DataFrame,
    cache: CategorizationCache,
) -> pd.DataFrame:
    """Match products against historical categorizations.

    `unique_products_df` needs a 'product' column. Returns it with 'category' (from history or
    NaN), a boolean 'previously_categorized', and 'match_type' added.
    """
    unique_products_df = unique_products_df.merge(
        cache.products[["product", "category"]],
        on="product",
        how="left",
        validate="many_to_one",
    )
    unique_products_df["previously_categorized"] = unique_products_df["category"].notna()

    # Provenance for diagnostics / the cleaned-name hit-rate count. Object dtype
    # so later steps can assign string labels alongside the initial NA values.
    unique_products_df["match_type"] = pd.Series(
        pd.NA, index=unique_products_df.index, dtype="object"
    )
    unique_products_df.loc[unique_products_df["previously_categorized"], "match_type"] = (
        MATCH_TYPE_RAW
    )

    n_matched = unique_products_df["previously_categorized"].sum()
    n_total = len(unique_products_df)
    logger.info("Historical match: %d/%d products found in cache.", n_matched, n_total)

    return unique_products_df


# ----------------------------------------------------------------------
# Name cleaning
# ----------------------------------------------------------------------
def clean_product_names(
    products_df: pd.DataFrame,
    llm: LlmClient,
) -> pd.DataFrame:
    """Clean product names for items that still need categorization.

    Items already matched historically get their original name as the cleaned
    name.  Uncategorized items are cleaned via an LLM call.

    `products_df` needs 'product', 'category', and 'previously_categorized'. Returns a copy with
    'cleaned_item_names' added.
    """
    products_df = products_df.copy()
    mask_needs_cleaning = products_df["category"].isna()
    num_to_clean = mask_needs_cleaning.sum()

    logger.info(
        "Detected %d items that need name cleaning (%d already categorized).",
        num_to_clean,
        (~mask_needs_cleaning).sum(),
    )

    if mask_needs_cleaning.any():
        items_to_clean = products_df.loc[mask_needs_cleaning, "product"]
        cleaned_names = map_concurrently(
            llm.clean_product_name,
            [str(item) for item in items_to_clean],
            max_workers=LLM_CONCURRENCY,
            progress_prefix="Name cleaning",
        )
        products_df.loc[mask_needs_cleaning, "cleaned_item_names"] = cleaned_names

    # Previously-categorized items keep their original name as cleaned name
    mask_prev = products_df["previously_categorized"]
    products_df.loc[mask_prev, "cleaned_item_names"] = products_df.loc[mask_prev, "product"]

    # Fallback for any remaining NaN
    products_df["cleaned_item_names"] = products_df["cleaned_item_names"].fillna(
        products_df["product"]
    )

    return products_df


# ----------------------------------------------------------------------
# Historical reuse on cleaned names
# ----------------------------------------------------------------------
def categorize_using_cleaned_name_history(
    products_df: pd.DataFrame,
    cache: CategorizationCache,
) -> pd.DataFrame:
    """Second historical lookup: reuse categories for *cleaned* names.

    After name cleaning, items still uncategorized are matched (case-,
    whitespace- and punctuation-insensitively) against previously-categorized
    cleaned names.  A hit reuses the cached category and is treated as trusted
    history — exactly like a raw-product cache hit — so it skips the LLM
    categorization step and the human-review file.

    Only unanimous, canonical-category matches are reused (see
    `CategorizationCache.cleaned_name_index`); everything else falls through to
    the LLM unchanged.

    `products_df` needs 'category', 'cleaned_item_names', 'previously_categorized' and
    'match_type', which are updated for matches.
    """
    products_df = products_df.copy()
    reuse_index = cache.cleaned_name_index

    mask_uncategorized = products_df["category"].isna()
    n_candidates = int(mask_uncategorized.sum())

    if n_candidates == 0 or not reuse_index:
        logger.info(
            "Cleaned-name reuse: 0/%d candidates matched (index has %d entries).",
            n_candidates,
            len(reuse_index),
        )
        return products_df

    candidates = products_df.loc[mask_uncategorized]
    normalized = candidates["cleaned_item_names"].map(normalize_product_name)
    reused_category = normalized.map(reuse_index)
    hit_index = reused_category.dropna().index

    products_df.loc[hit_index, "category"] = reused_category.loc[hit_index]
    products_df.loc[hit_index, "previously_categorized"] = True
    products_df.loc[hit_index, "match_type"] = MATCH_TYPE_CLEANED

    logger.info(
        "Cleaned-name reuse: %d/%d candidates matched against %d index entries.",
        len(hit_index),
        n_candidates,
        len(reuse_index),
    )

    return products_df


# ----------------------------------------------------------------------
# LLM categorization
# ----------------------------------------------------------------------
def categorize_with_llm(
    products_df: pd.DataFrame,
    llm: LlmClient,
) -> pd.DataFrame:
    """Apply LLM-based categorization to products not matched historically.

    `products_df` needs 'category' and 'cleaned_item_names'. Returns a copy with 'category'
    filled for uncategorized rows. An answer is matched to a GBD category ignoring case and
    punctuation; any other answer becomes "No Matches Found", counted in one warning.
    """
    products_df = products_df.copy()
    gbd_categories = category_names()
    canonical_by_normalized = {
        normalize_product_name(name): name for name in [*gbd_categories, NO_MATCHES_FOUND]
    }

    mask_needs_categorization = products_df["category"].isna()
    total_to_categorize = int(mask_needs_categorization.sum())

    logger.info(
        "Detected %d items that need LLM categorization (%d already categorized).",
        total_to_categorize,
        (~mask_needs_categorization).sum(),
    )

    # Record provenance for items routed to the LLM (guarded: the column is
    # absent when this step is exercised in isolation).
    if "match_type" in products_df.columns:
        products_df.loc[mask_needs_categorization, "match_type"] = MATCH_TYPE_LLM

    if total_to_categorize > 0:
        items_to_categorize = products_df.loc[mask_needs_categorization, "cleaned_item_names"]
        # Categorize each unique cleaned name once, then fan the result back out
        # to every row that shares it — duplicate cleaned names cost one call.
        unique_names = pd.unique(items_to_categorize.dropna())
        answers = map_concurrently(
            lambda name: llm.match_product_to_category(name, gbd_categories),
            [str(name) for name in unique_names],
            max_workers=LLM_CONCURRENCY,
            progress_prefix="Categorization",
        )
        name_to_category: dict[Any, str] = {}
        unrecognized: Counter[str] = Counter()
        for name, answer in zip(unique_names, answers, strict=True):
            category = canonical_by_normalized.get(normalize_product_name(answer))
            if category is None:
                unrecognized[answer] += 1
                category = NO_MATCHES_FOUND
            name_to_category[name] = category

        # One bounded line, not one per item: the worker keeps only the last 8 KB of the child's
        # stderr. It names no items, though an answer can echo one.
        if unrecognized:
            logger.warning(
                "%d of %d LLM answers were not recognized; most common: %s",
                unrecognized.total(),
                len(unique_names),
                unrecognized.most_common(5),
            )

        products_df.loc[mask_needs_categorization, "category"] = items_to_categorize.map(
            name_to_category
        )

    products_df["category"] = products_df["category"].fillna(NO_MATCHES_FOUND).astype(str)
    return products_df


# ----------------------------------------------------------------------
# Merge and filter
# ----------------------------------------------------------------------
@dataclass(frozen=True)
class MergeCounts:
    """How many rows and products survived the merge, and why the rest did not."""

    n_rows_before: int
    n_rows_after: int
    n_products_before: int
    n_products_after: int
    n_rows_uncategorized: int


def merge_categorizations(
    original_df: pd.DataFrame,
    categorized_products_df: pd.DataFrame,
) -> tuple[pd.DataFrame, MergeCounts]:
    """Merge categorizations back to the cleaned input data and filter it for aggregation.

    Drops "No Matches Found" rows and the intermediate categorization columns. Raises
    UnusableDataError if fewer than 20% of products survive.
    """
    n_rows_before = len(original_df)
    n_products_before = original_df["product"].nunique()

    df_final = original_df.merge(
        categorized_products_df[["product", "category"]],
        on="product",
        how="left",
        validate="many_to_one",
    )
    df_final["category"] = df_final["category"].fillna("No Matches Found")

    # Track elimination
    n_rows_uncategorized = int((df_final["category"] == "No Matches Found").sum())
    df_final = df_final.loc[df_final["category"] != "No Matches Found"]

    n_products_after = df_final["product"].nunique()

    if n_products_before == 0:
        raise ValueError("n_products_before is zero — cannot compute elimination rate.")

    pct_remaining = n_products_after / n_products_before

    if pct_remaining < 0.2:
        raise UnusableDataError(
            "Over 80% of products were eliminated during categorization: "
            f"{n_products_after}/{n_products_before} ({pct_remaining:.1%}) remain."
        )

    # Drop intermediate columns
    columns_to_drop = [
        "cleaned_item_names",
        "previously_categorized",
        "match_type",
    ]
    columns_to_drop = [c for c in columns_to_drop if c in df_final.columns]
    df_final = df_final.drop(columns=columns_to_drop)

    logger.info(
        "Categorization complete: %d/%d products retained (%.1f%%).",
        n_products_after,
        n_products_before,
        pct_remaining * 100,
    )

    return df_final, MergeCounts(
        n_rows_before=n_rows_before,
        n_rows_after=len(df_final),
        n_products_before=n_products_before,
        n_products_after=n_products_after,
        n_rows_uncategorized=n_rows_uncategorized,
    )
