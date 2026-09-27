"""
Categorization Steps
=====================

Non-entree categorization steps: historical reuse, name cleaning,
LLM categorization, fuzzy matching, and merge-back.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from gbd_foodservice_insights.categories import get_GBD_categories
from gbd_foodservice_insights.categorization.cache import (
    _normalize_product_name,
    build_cleaned_name_reuse_index,
    get_previously_categorized_items,
)
from gbd_foodservice_insights.categorization.llm import LlmClient
from gbd_foodservice_insights.errors import UnusableDataError
from gbd_foodservice_insights.utils import print_progress

MATCH_TYPE_RAW = "raw_product_history"
MATCH_TYPE_CLEANED = "cleaned_name_history"
MATCH_TYPE_LLM = "llm"

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# Step 1 — Historical reuse
# ----------------------------------------------------------------------
def categorize_using_historical_classifications(
    unique_products_df: pd.DataFrame,
    historical_df: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """
    Match products against historical categorizations.

    Parameters
    ----------
    unique_products_df : DataFrame
        Must contain a 'product' column.
    historical_df : DataFrame, optional
        Historical data with 'product' and 'category' columns.
        If None, loads from default cache.

    Returns
    -------
    DataFrame
        Input with 'category' (from history or NaN) and 'previously_categorized'
        boolean columns added.
    """
    if historical_df is None:
        historical_df = get_previously_categorized_items()

    historical_subset = historical_df[["product", "category"]].drop_duplicates(
        subset=["product"], keep="last"
    )
    unique_products_df = unique_products_df.merge(historical_subset, on="product", how="left")
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
# Step 2 — Name cleaning
# ----------------------------------------------------------------------
def clean_product_names(
    products_df: pd.DataFrame,
    llm: LlmClient,
) -> pd.DataFrame:
    """
    Clean product names for items that still need categorization.

    Items already matched historically get their original name as the cleaned
    name.  Uncategorized items are cleaned via an LLM call.

    Parameters
    ----------
    products_df : DataFrame
        Must contain 'product', 'category', and 'previously_categorized' columns.
    llm : LlmClient

    Returns
    -------
    DataFrame
        Input with 'cleaned_item_names' column added.
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
        cleaned_names = []
        for idx, item in enumerate(items_to_clean, 1):
            cleaned_names.append(llm.clean_product_name(str(item)))
            print_progress("Name cleaning", idx, num_to_clean)
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
# Step 2.5 — Historical reuse on cleaned names
# ----------------------------------------------------------------------
def categorize_using_cleaned_name_history(
    products_df: pd.DataFrame,
    reuse_index: dict[str, str] | None = None,
) -> pd.DataFrame:
    """
    Second historical lookup: reuse categories for *cleaned* names.

    After name cleaning, items still uncategorized are matched (case-,
    whitespace- and punctuation-insensitively) against previously-categorized
    cleaned names.  A hit reuses the cached category and is treated as trusted
    history — exactly like a raw-product cache hit — so it skips the LLM
    categorization step and the human-review file.

    Only unanimous, canonical-category matches are reused (see
    :func:`build_cleaned_name_reuse_index`); everything else falls through to
    the LLM unchanged.

    Parameters
    ----------
    products_df : DataFrame
        Must contain 'category', 'cleaned_item_names', 'previously_categorized'
        and 'match_type' columns.
    reuse_index : dict[str, str], optional
        Pre-built ``{normalized cleaned name -> category}`` map. If None, it is
        built from the default caches.

    Returns
    -------
    DataFrame
        Input with 'category', 'previously_categorized' and 'match_type'
        updated for any cleaned-name matches.
    """
    products_df = products_df.copy()

    if reuse_index is None:
        reuse_index = build_cleaned_name_reuse_index()

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
    normalized = candidates["cleaned_item_names"].map(_normalize_product_name)
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
# Step 3 — LLM categorization
# ----------------------------------------------------------------------
def categorize_with_llm(
    products_df: pd.DataFrame,
    llm: LlmClient,
) -> pd.DataFrame:
    """
    Apply LLM-based categorization to products not matched historically.

    Parameters
    ----------
    products_df : DataFrame
        Must contain 'category' and 'cleaned_item_names' columns.
    llm : LlmClient

    Returns
    -------
    DataFrame
        Input with 'category' column updated for previously-uncategorized items.
    """
    products_df = products_df.copy()
    gbd_categories = get_GBD_categories()

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
        name_to_category: dict[Any, str] = {}
        for idx, name in enumerate(unique_names, 1):
            name_to_category[name] = llm.match_product_to_category(str(name), gbd_categories)
            print_progress("Categorization", idx, len(unique_names))

        products_df.loc[mask_needs_categorization, "category"] = items_to_categorize.map(
            name_to_category
        )

    # Ensure category is string and set non-GBD results to "No Matches Found"
    products_df["category"] = products_df["category"].fillna("No Matches Found").astype(str)
    products_df.loc[~products_df["category"].isin(gbd_categories), "category"] = "No Matches Found"

    return products_df


# ----------------------------------------------------------------------
# Step 4 — Fuzzy matching
# ----------------------------------------------------------------------
def fuzzy_match_GBD_categories(
    products_df: pd.DataFrame,
    llm: LlmClient,
) -> pd.DataFrame:
    """
    Standardize category values by fuzzy-matching non-standard ones.

    Replaces various forms of "uncategorized" with "No Matches Found", then
    runs fuzzy matching on any remaining non-standard categories.

    Parameters
    ----------
    products_df : DataFrame
        Must contain a 'category' column.
    llm : LlmClient

    Returns
    -------
    DataFrame
        Input with standardized 'category' column and 'category_old' backup.
    """
    products_df = products_df.copy()

    # Standardize known uncategorized variants
    nan_categories = [
        np.nan,
        "nan",
        "Uncategorized",
        "None.",
        "None",
        "none",
        "none.",
        "other",
    ]
    products_df.loc[products_df["category"].isin(nan_categories), "category"] = "No Matches Found"

    # Fuzzy match remaining non-standard categories
    canonical: list[str] = [*get_GBD_categories(), "No Matches Found"]
    products_df["category_old"] = products_df["category"]

    non_canonical_mask = ~products_df["category"].isin(canonical)
    n_fuzzy = non_canonical_mask.sum()

    if n_fuzzy > 0:
        logger.info("Fuzzy-matching %d non-standard categories.", n_fuzzy)
        products_df.loc[non_canonical_mask, "category"] = products_df.loc[
            non_canonical_mask, "category_old"
        ].apply(lambda x: llm.fuzzy_match_category(str(x), canonical))
    else:
        logger.info("All categories are standard — no fuzzy matching needed.")

    return products_df


# ----------------------------------------------------------------------
# Step 7 — Merge and filter
# ----------------------------------------------------------------------
@dataclass(frozen=True)
class MergeCounts:
    """How many rows and products survived the merge, and why the rest did not."""

    n_rows_before: int
    n_rows_after: int
    n_products_before: int
    n_products_after: int
    n_rows_uncategorized: int
    # None when no entree filter ran, so procurement summaries omit the key.
    n_rows_non_entree: int | None = None

    def to_summary(self) -> dict[str, Any]:
        row_elimination_details: dict[str, Any] = {
            "total_rows_initial": self.n_rows_before,
            "total_rows_final": self.n_rows_after,
            "total_rows_eliminated": self.n_rows_before - self.n_rows_after,
            "total_eliminated_pct": self._pct_of_rows(self.n_rows_before - self.n_rows_after),
            "rows_eliminated_uncategorized": self.n_rows_uncategorized,
            "rows_eliminated_uncategorized_pct": self._pct_of_rows(self.n_rows_uncategorized),
        }
        if self.n_rows_non_entree is not None:
            row_elimination_details |= {
                "rows_eliminated_non_entree": self.n_rows_non_entree,
                "rows_eliminated_non_entree_pct": self._pct_of_rows(self.n_rows_non_entree),
            }
        return {
            "n_products_before": self.n_products_before,
            "n_products_after": self.n_products_after,
            "pct_remaining": self.n_products_after / self.n_products_before,
            "n_rows_before": self.n_rows_before,
            "n_rows_after": self.n_rows_after,
            "row_elimination_details": row_elimination_details,
        }

    def _pct_of_rows(self, n_rows: int) -> float:
        return n_rows / self.n_rows_before if self.n_rows_before > 0 else 0


def merge_categorizations(
    original_df: pd.DataFrame,
    categorized_products_df: pd.DataFrame,
) -> tuple[pd.DataFrame, MergeCounts]:
    """
    Merge categorizations back to the original data and filter.

    Parameters
    ----------
    original_df : DataFrame
        The cleaned input data.
    categorized_products_df : DataFrame
        Unique products with their assigned categories.

    Returns
    -------
    tuple[DataFrame, MergeCounts]
        - Filtered DataFrame ready for aggregation.
        - Row and product counts before and after the merge.
    """
    n_rows_before = len(original_df)
    n_products_before = original_df["product"].nunique()

    df_final = original_df.merge(
        categorized_products_df[["product", "category"]],
        on="product",
        how="left",
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
        "category_old",
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
