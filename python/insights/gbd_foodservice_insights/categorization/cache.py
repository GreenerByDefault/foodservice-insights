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
NO_MATCHES_FOUND: Final = "No Matches Found"


@dataclass(frozen=True)
class CategorizationCache:
    """The reviewed cache, in the one shape the pipeline matches against: build it with
    `from_frame`, which enforces that shape. The constructor rejects only a category outside the
    GBD list, the one flaw that would reach a report rather than fail a merge.

    `products` holds `CACHE_COLUMNS` as `str`, one row per stripped, non-empty product, each with
    a GBD category or "No Matches Found"; a missing cleaned name is "". `cleaned_name_index` maps
    a normalized cleaned name to the category every row with that name agrees on.
    """

    products: pd.DataFrame
    cleaned_name_index: Mapping[str, str]

    def __post_init__(self) -> None:
        gbd_categories = set(get_GBD_categories())
        unknown = sorted(set(self.products["category"]) - {*gbd_categories, NO_MATCHES_FOUND})
        if unknown:
            raise ValueError(f"Categorization cache has categories outside the GBD list: {unknown}")
        # Reusing "No Matches Found" would skip the LLM and the review table for good.
        unreusable = sorted(set(self.cleaned_name_index.values()) - gbd_categories)
        if unreusable:
            raise ValueError(f"Cleaned-name index has non-GBD categories: {unreusable}")

    @classmethod
    def from_frame(cls, df: pd.DataFrame) -> CategorizationCache:
        """Drops, with a WARNING per reason, each row the pipeline could not use as is."""
        missing = [column for column in CACHE_COLUMNS if column not in df.columns]
        if missing:
            raise ValueError(f"Categorization cache is missing columns: {missing}")

        products = df.loc[:, list(CACHE_COLUMNS)].fillna("").astype(str)
        n_loaded = len(products)
        # The upload's products are stripped before matching; the cache's must be too, or a row
        # with surrounding whitespace can never hit.
        products = products.assign(product=products["product"].str.strip())

        blank_product = products["product"] == ""
        _warn_dropped(blank_product, "a blank product")
        products = products.loc[~blank_product]

        # Dropped rather than rejected: a typo among tens of thousands of hand-maintained rows
        # must not fail every report, and dropping it costs only LLM calls and a review-table
        # entry. Kept, the row would fail the constructor's check, and with it every report.
        allowed_categories = {*get_GBD_categories(), NO_MATCHES_FOUND}
        unknown_category = ~products["category"].isin(allowed_categories)
        _warn_dropped(
            unknown_category,
            "a blank or unknown category "
            f"{sorted(products.loc[unknown_category, 'category'].unique())}",
        )
        products = products.loc[~unknown_category]

        duplicated = products["product"].duplicated(keep="last")
        _warn_dropped(duplicated, "a product repeated by a later row")
        products = products.loc[~duplicated].reset_index(drop=True)

        logger.info("Categorization cache: kept %d of %d rows.", len(products), n_loaded)
        return cls(products=products, cleaned_name_index=_build_cleaned_name_index(products))


def _warn_dropped(mask: pd.Series, reason: str) -> None:
    if mask.any():
        logger.warning("Categorization cache: dropped %d rows with %s.", mask.sum(), reason)


def _build_cleaned_name_index(products: pd.DataFrame) -> dict[str, str]:
    # "No Matches Found" is excluded before the unanimity check, so it never blocks a real
    # category and is never reused.
    eligible = products.loc[products["category"] != NO_MATCHES_FOUND]
    index = unanimous_index(eligible, key_col="cleaned_item_names", value_col="category")
    logger.info("Built cleaned-name reuse index with %d entries.", len(index))
    return index


def categorization_cache_path() -> Path:
    return PACKAGE_DIR / "data_files" / "previously_categorized_items.csv"


def read_categorization_cache_csv() -> pd.DataFrame:
    """The cache file exactly as written, every cell a `str` (so a product named `NA` stays
    one); empty, with `CACHE_COLUMNS`, when the file is missing.

    The pipeline wants `load_categorization_cache`. This is for the lab's writers, which must
    append to the file without discarding the rows `from_frame` drops.
    """
    path = categorization_cache_path()
    if not path.exists():
        logger.warning(
            "Historical cache not found at %s (see data_files/README.md); every product will go "
            "to the LLM.",
            path,
        )
        return pd.DataFrame(columns=list(CACHE_COLUMNS), dtype=str)

    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    logger.info("Read %d rows from historical cache.", len(df))
    return df


def load_categorization_cache() -> CategorizationCache:
    return CategorizationCache.from_frame(read_categorization_cache_csv())
