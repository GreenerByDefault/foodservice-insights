"""
Entree Cache
============

Historical entree-classification persistence for serving data, plus the entree-label
constants and the label normalizer used during cache I/O.
"""

import logging
import re
from pathlib import Path
from typing import Any

import pandas as pd
from gbd_foodservice_insights.categorization.cache import CategorizationCache, unanimous_index

from gbd_foodservice_insights_lab import PACKAGE_DIR
from gbd_foodservice_insights_lab.categorization.product_cache import load_categorization_cache

logger = logging.getLogger(__name__)

ENTREE_LABEL_ENTREE = "entree"
ENTREE_LABEL_SIDE_ADDON = "side/add-on"
ENTREE_LABEL_UNSURE = "unsure"
ENTREE_CACHE_COLUMNS = ("product", "entree_classification")


def _normalize_entree_classification(
    label: Any,
    allow_unsure: bool = False,
) -> str:
    """Normalize raw or historical entree labels to the canonical label set."""
    if pd.isna(label):
        raise ValueError("Entree classification cannot be NaN when normalization is required.")

    raw_label = str(label).strip().strip("\"'`").lower().rstrip(".")
    compact_label = re.sub(r"[^a-z]", "", raw_label)

    if compact_label == "entree":
        return ENTREE_LABEL_ENTREE
    if compact_label in {
        "sideaddon",
        "side",
        "addon",
        "addononly",
        "addonitem",
        "notentree",
        "notanentree",
    }:
        return ENTREE_LABEL_SIDE_ADDON
    if allow_unsure and compact_label == "unsure":
        return ENTREE_LABEL_UNSURE

    raise ValueError(
        f"Unexpected entree classification '{label}'. Expected "
        f"'{ENTREE_LABEL_ENTREE}' or '{ENTREE_LABEL_SIDE_ADDON}'"
        + (f", or '{ENTREE_LABEL_UNSURE}'." if allow_unsure else ".")
    )


def get_previously_classified_entrees_location() -> Path:
    """Return the canonical historical entree CSV path."""
    return PACKAGE_DIR / "data_files" / "previously_classified_entrees.csv"


def _empty_previously_classified_entrees() -> pd.DataFrame:
    """Return an empty DataFrame with the historical entree cache schema."""
    return pd.DataFrame(columns=list(ENTREE_CACHE_COLUMNS))


def get_previously_classified_entrees() -> pd.DataFrame:
    """Load historical entree classifications from the canonical CSV."""
    path = get_previously_classified_entrees_location()
    if not path.exists():
        logger.warning(
            "Historical entree cache not found at %s (see data_files/README.md); every product "
            "will go to the LLM.",
            path,
        )
        return _empty_previously_classified_entrees()

    # Only an empty cell is missing, so a product named `NA` or `None` stays one.
    df = pd.read_csv(path, dtype=str, keep_default_na=False, na_values=[""])
    missing_cols = set(ENTREE_CACHE_COLUMNS) - set(df.columns)
    if missing_cols:
        raise ValueError(
            f"Historical entree classifications missing columns: {sorted(missing_cols)}"
        )
    # A file from before cleaned names moved to the product cache still has their column.
    df = df.loc[:, list(ENTREE_CACHE_COLUMNS)]
    if not df.empty:
        df["entree_classification"] = df["entree_classification"].apply(
            _normalize_entree_classification
        )
    logger.info("Loaded %d items from historical entree classifications.", len(df))
    return df


def build_entree_cleaned_name_reuse_index(
    historical_df: pd.DataFrame | None = None,
    product_cache: CategorizationCache | None = None,
) -> dict[str, str]:
    """
    Build a ``{normalized cleaned name -> entree classification}`` reuse index
    from the historical entree cache.

    A historical product's cleaned name is the product cache's, or the product
    itself where that has none.  A cleaned name is only included when every
    contributing row agrees on a single label.
    """
    if historical_df is None:
        historical_df = get_previously_classified_entrees()
    work = historical_df[["product", "entree_classification"]].dropna(
        subset=["entree_classification"]
    )
    if work.empty:
        return {}
    if product_cache is None:
        product_cache = load_categorization_cache()

    products = product_cache.products
    cleaned_names = products.loc[
        products["cleaned_item_names"] != "", ["product", "cleaned_item_names"]
    ]
    work = work.merge(cleaned_names, on="product", how="left", validate="many_to_one")
    work["cleaned_item_names"] = work["cleaned_item_names"].fillna(work["product"])
    work["entree_classification"] = work["entree_classification"].apply(
        _normalize_entree_classification
    )
    index = unanimous_index(work, key_col="cleaned_item_names", value_col="entree_classification")
    logger.info("Built entree cleaned-name reuse index with %d entries.", len(index))
    return index


def save_historical_entree_classifications(new_df: pd.DataFrame) -> None:
    """
    Append new entree classifications to historical data and de-duplicate.
    """
    missing_cols = set(ENTREE_CACHE_COLUMNS) - set(new_df.columns)
    if missing_cols:
        raise ValueError(f"new_df missing required columns for entree save: {sorted(missing_cols)}")

    existing = get_previously_classified_entrees()
    valid_rows = new_df.loc[:, list(ENTREE_CACHE_COLUMNS)].copy()
    valid_rows = valid_rows.dropna(subset=["entree_classification"])
    valid_rows = valid_rows.loc[valid_rows["entree_classification"].astype(str).str.strip() != ""]
    if not valid_rows.empty:
        valid_rows["entree_classification"] = valid_rows["entree_classification"].apply(
            _normalize_entree_classification
        )
    if valid_rows.empty:
        logger.info("No valid entree classifications to append.")
        return

    combined = pd.concat([existing, valid_rows], ignore_index=True)
    combined = combined.drop_duplicates(subset=["product"], keep="last")
    combined.to_csv(get_previously_classified_entrees_location(), index=False)

    logger.info(
        "Historical entree classifications updated: %d unique products.",
        combined["product"].nunique(),
    )
