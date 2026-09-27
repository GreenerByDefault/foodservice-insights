"""
Categorization Cache
====================

Reads the reviewed product-categorization cache. The product never writes it: new rows reach
it only through GBD's review, via the lab's `categorization.product_cache`.
"""

import logging
import re
from pathlib import Path
from typing import Any

import pandas as pd

from gbd_foodservice_insights import PACKAGE_DIR
from gbd_foodservice_insights.categories import get_GBD_categories

logger = logging.getLogger(__name__)


def normalize_product_name(value: Any) -> str:
    """
    Normalize a (cleaned) product name into a match key for cleaned-name reuse.

    Lower-cases, then collapses any run of non-alphanumeric characters to a
    single space and trims.  Digits are deliberately kept — unlike the lab's entree-label
    normalizer, which strips them — so names such as
    "7 Up" or "100% Beef" keep their numbers.  Returns "" for NaN/empty input.

    The same function is applied to both sides of every cleaned-name match, so
    casing/whitespace/punctuation differences never block a match.
    """
    if pd.isna(value):
        return ""
    text = str(value).strip().lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def unanimous_index(
    df: pd.DataFrame,
    key_col: str,
    value_col: str,
) -> dict[str, str]:
    """
    Build a ``{normalized key_col -> value}`` map, keeping only keys whose rows
    all agree on a single value (reuse only when unanimous).

    Rows with a NaN key/value or an empty normalized key are ignored.  Callers
    are responsible for pre-filtering ``value_col`` to the values eligible for
    reuse (e.g. canonical categories only, never "No Matches Found").
    """
    if df.empty:
        return {}

    work = df[[key_col, value_col]].copy()
    work = work.dropna(subset=[key_col, value_col])
    work["_key"] = work[key_col].map(normalize_product_name)
    work = work.loc[work["_key"] != ""]
    if work.empty:
        return {}

    distinct_per_key = work.groupby("_key")[value_col].transform("nunique")
    unanimous = work.loc[distinct_per_key == 1].drop_duplicates(subset=["_key"], keep="first")
    return dict(zip(unanimous["_key"], unanimous[value_col], strict=True))


# ----------------------------------------------------------------------
# Reviewed historical cache
# ----------------------------------------------------------------------
def categorization_cache_path() -> Path:
    return PACKAGE_DIR / "data_files" / "previously_categorized_items.csv"


def _empty_historical_cache() -> pd.DataFrame:
    """Return an empty DataFrame with the historical cache schema."""
    return pd.DataFrame(columns=["product", "category", "cleaned_item_names"])


def get_previously_categorized_items() -> pd.DataFrame:
    """Load the previously categorized items from the cache CSV.

    The returned DataFrame has at least 'product' and 'category' columns, and is empty when the
    CSV is missing.
    """
    path = categorization_cache_path()
    if not path.exists():
        logger.warning(
            "Historical cache not found at %s (see data_files/README.md); every product will go "
            "to the LLM.",
            path,
        )
        return _empty_historical_cache()

    df = pd.read_csv(path)
    logger.info("Loaded %d items from historical cache.", len(df))
    return df


# ----------------------------------------------------------------------
# Cleaned-name reuse index
# ----------------------------------------------------------------------
def build_cleaned_name_reuse_index(reviewed_df: pd.DataFrame) -> dict[str, str]:
    """
    Build a ``{normalized cleaned name -> GBD category}`` reuse index from the reviewed cache.

    Only canonical GBD categories are eligible ("No Matches Found" and any
    non-canonical label are excluded), and a cleaned name is only included when
    every contributing row agrees on a single category.
    """
    if not {"cleaned_item_names", "category"}.issubset(reviewed_df.columns):
        return {}
    valid_categories = set(get_GBD_categories())
    eligible = reviewed_df.loc[reviewed_df["category"].isin(valid_categories)]

    index = unanimous_index(eligible, key_col="cleaned_item_names", value_col="category")
    logger.info("Built cleaned-name reuse index with %d entries.", len(index))
    return index
