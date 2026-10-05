"""
Categorization Cache
====================

Reads the reviewed product-categorization cache. The product never writes it: new rows reach
it only through GBD's review, via the lab's `categorization.product_cache`.
"""

import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

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
CACHE_COLUMNS: Final = ("product", "category", "cleaned_item_names")


@dataclass(frozen=True)
class CategorizationCache:
    """The reviewed cache, as the pipeline matches against it: build it with `from_frame`.

    `products` holds one row per product, the last when the file repeats one.
    `cleaned_name_index` maps a normalized cleaned name to the canonical category every row with
    that name agrees on.
    """

    products: pd.DataFrame
    cleaned_name_index: Mapping[str, str]

    @classmethod
    def from_frame(cls, df: pd.DataFrame) -> CategorizationCache:
        products = df.drop_duplicates(subset=["product"], keep="last")
        # Built from every row, repeats included, so a repeated product whose rows disagree still
        # keeps its cleaned name out of the index.
        return cls(products=products, cleaned_name_index=_build_cleaned_name_index(df))


def _build_cleaned_name_index(df: pd.DataFrame) -> dict[str, str]:
    if "cleaned_item_names" not in df.columns:
        return {}
    # Only canonical categories are eligible, so "No Matches Found" never blocks a real category
    # and is never reused.
    eligible = df.loc[df["category"].isin(set(get_GBD_categories()))]
    index = unanimous_index(eligible, key_col="cleaned_item_names", value_col="category")
    logger.info("Built cleaned-name reuse index with %d entries.", len(index))
    return index


def categorization_cache_path() -> Path:
    return PACKAGE_DIR / "data_files" / "previously_categorized_items.csv"


def read_categorization_cache_csv() -> pd.DataFrame:
    """The cache file exactly as written; empty, with `CACHE_COLUMNS`, when the file is missing.

    The pipeline wants `load_categorization_cache`. This is for the lab, which reads and appends
    to the file itself.
    """
    path = categorization_cache_path()
    if not path.exists():
        logger.warning(
            "Historical cache not found at %s (see data_files/README.md); every product will go "
            "to the LLM.",
            path,
        )
        return pd.DataFrame(columns=list(CACHE_COLUMNS))

    df = pd.read_csv(path)
    logger.info("Loaded %d items from historical cache.", len(df))
    return df


def load_categorization_cache() -> CategorizationCache:
    return CategorizationCache.from_frame(read_categorization_cache_csv())
