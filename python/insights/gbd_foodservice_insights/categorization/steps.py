"""
Categorization Steps
=====================

Non-entree categorization steps: historical reuse, name cleaning,
LLM categorization, and merge-back.
"""

import logging
from collections import Counter
from typing import Any

import pandas as pd

from gbd_foodservice_insights.categories import category_names
from gbd_foodservice_insights.categorization.cache import (
    NO_MATCHES_FOUND,
    CategorizationCache,
    normalize_product_name,
    unanimous_index,
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
    NaN) and 'match_type' added.
    """
    exact = unique_products_df.merge(
        cache.products[["product", "category"]],
        on="product",
        how="left",
        validate="many_to_one",
    )
    # The same product spelled with other casing, spacing or punctuation reuses the category,
    # "No Matches Found" included, when every spelling in the cache agrees. It fills only what the
    # exact match missed, so a spelling whose variants disagree never overrides an exact hit.
    by_spelling = (
        exact["product"]
        .map(normalize_product_name)
        .map(unanimous_index(cache.products, key_col="product", value_col="category"))
    )
    unique_products_df = exact.assign(category=exact["category"].fillna(by_spelling))
    matched = unique_products_df["category"].notna()

    # Provenance for diagnostics / the cleaned-name hit-rate count. Object dtype
    # so later steps can assign string labels alongside the initial NA values.
    unique_products_df["match_type"] = pd.Series(
        pd.NA, index=unique_products_df.index, dtype="object"
    )
    unique_products_df.loc[matched, "match_type"] = MATCH_TYPE_RAW

    n_matched = matched.sum()
    n_total = len(unique_products_df)
    logger.info(
        "Historical match: %d/%d products found in cache (%d spelled differently).",
        n_matched,
        n_total,
        n_matched - exact["category"].notna().sum(),
    )

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

    `products_df` needs 'product' and 'category'. Returns a copy with 'cleaned_item_names' added.
    """
    products_df = products_df.assign(cleaned_item_names=products_df["product"])
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

    `products_df` needs 'category', 'cleaned_item_names' and 'match_type'; the first and last
    are updated for matches.
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
) -> tuple[pd.DataFrame, int]:
    """Apply LLM-based categorization to products not matched historically.

    `products_df` needs 'category', 'cleaned_item_names' and 'match_type'. Returns a copy with
    'category' filled and 'match_type' set for uncategorized rows, and how many answers were not
    recognized. An answer is matched to a GBD category ignoring case and punctuation; any other
    answer becomes "No Matches Found", counted in one warning.
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

    products_df.loc[mask_needs_categorization, "match_type"] = MATCH_TYPE_LLM

    unrecognized: Counter[str] = Counter()
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
    return products_df, unrecognized.total()


# ----------------------------------------------------------------------
# Merge and filter
# ----------------------------------------------------------------------
def merge_categorizations(
    original_df: pd.DataFrame,
    categorized_products_df: pd.DataFrame,
) -> pd.DataFrame:
    """Merge categorizations back onto the rows, dropping "No Matches Found" rows.

    `categorized_products_df` must categorize every product in `original_df`, as
    `categorize_unique_products` does. Raises UnusableDataError if fewer than 20% of products
    survive.
    """
    n_products_before = original_df["product"].nunique()
    if n_products_before == 0:
        raise ValueError("n_products_before is zero — cannot compute elimination rate.")

    merged = original_df.merge(
        categorized_products_df[["product", "category"]],
        on="product",
        how="left",
        validate="many_to_one",
    )
    # Both frames come from one `categorize_unique_products` call, so a gap is a bug. Counted, not
    # named: the worker keeps the child's stderr, and product names are customer data.
    n_uncategorized_products = merged.loc[merged["category"].isna(), "product"].nunique()
    if n_uncategorized_products > 0:
        raise ValueError(
            f"No categorization for {n_uncategorized_products} of {n_products_before} products."
        )

    df_final = merged.loc[merged["category"] != NO_MATCHES_FOUND]
    n_products_after = df_final["product"].nunique()

    pct_remaining = n_products_after / n_products_before
    if pct_remaining < 0.2:
        raise UnusableDataError(
            "Over 80% of products were eliminated during categorization: "
            f"{n_products_after}/{n_products_before} ({pct_remaining:.1%}) remain."
        )

    logger.info(
        "Categorization complete: %d/%d products (%.1f%%) and %d/%d rows retained.",
        n_products_after,
        n_products_before,
        pct_remaining * 100,
        len(df_final),
        len(original_df),
    )

    return df_final
