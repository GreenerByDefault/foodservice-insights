"""
Entree Cache
============

The historical entree-classification cache for serving data, plus the entree-label
constants and the label normalizer used during cache I/O.
"""

import logging
import re
from pathlib import Path
from typing import Any

import pandas as pd
from gbd_foodservice_insights.categorization.cache import unanimous_index

from gbd_foodservice_insights_lab import PACKAGE_DIR
from gbd_foodservice_insights_lab.categorization.product_cache import load_categorization_cache

logger = logging.getLogger(__name__)

ENTREE_LABEL_ENTREE = "entree"
ENTREE_LABEL_SIDE_ADDON = "side/add-on"
ENTREE_LABEL_UNSURE = "unsure"


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
    return pd.DataFrame(columns=["product", "entree_classification", "cleaned_item_names"])


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
    required_cols = {"product", "entree_classification"}
    missing_cols = required_cols - set(df.columns)
    if missing_cols:
        raise ValueError(
            f"Historical entree classifications missing columns: {sorted(missing_cols)}"
        )
    # Back-compat: pre-migration files have no cleaned-name column. Add an empty
    # one so callers can rely on it; the cleaned-name reuse index then simply
    # yields nothing until the column is backfilled / accumulated.
    if "cleaned_item_names" not in df.columns:
        df["cleaned_item_names"] = pd.NA
    if not df.empty:
        df["entree_classification"] = df["entree_classification"].apply(
            _normalize_entree_classification
        )
    logger.info("Loaded %d items from historical entree classifications.", len(df))
    return df


def build_entree_cleaned_name_reuse_index(
    historical_df: pd.DataFrame | None = None,
) -> dict[str, str]:
    """
    Build a ``{normalized cleaned name -> entree classification}`` reuse index
    from the historical entree cache.

    Returns ``{}`` when the cache carries no cleaned names (e.g. a pre-migration
    file that has not yet been backfilled).  A cleaned name is only included
    when every contributing row agrees on a single label.
    """
    if historical_df is None:
        historical_df = get_previously_classified_entrees()
    if historical_df.empty or "cleaned_item_names" not in historical_df.columns:
        return {}

    work = historical_df[["cleaned_item_names", "entree_classification"]].copy()
    work = work.dropna(subset=["entree_classification"])
    if work.empty:
        return {}

    work["entree_classification"] = work["entree_classification"].apply(
        _normalize_entree_classification
    )
    index = unanimous_index(work, key_col="cleaned_item_names", value_col="entree_classification")
    logger.info("Built entree cleaned-name reuse index with %d entries.", len(index))
    return index


def backfill_entree_cleaned_names() -> dict[str, int]:
    """
    One-shot migration: populate ``cleaned_item_names`` in the entree cache by
    borrowing names from the category cache (joined on ``product``).

    Existing non-empty cleaned names are preserved; products absent from the
    category cache fall back to their raw product name.  Idempotent — re-running
    only fills rows that are still empty.  Returns counts for logging.
    """
    entree = get_previously_classified_entrees()
    n_total = len(entree)

    category = load_categorization_cache().products
    name_map = category.loc[category["cleaned_item_names"] != "", ["product", "cleaned_item_names"]]

    existing_clean = entree["cleaned_item_names"]
    has_clean = existing_clean.notna() & (existing_clean.astype(str).str.strip() != "")
    n_already = int(has_clean.sum())

    borrowed = entree[["product"]].merge(name_map, on="product", how="left")["cleaned_item_names"]
    borrowed.index = entree.index
    n_borrowed = int((~has_clean & borrowed.notna()).sum())

    filled = existing_clean.where(has_clean, borrowed).fillna(entree["product"])
    n_fallback = n_total - n_already - n_borrowed

    entree = entree.copy()
    entree["cleaned_item_names"] = filled
    ordered_cols = ["product", "entree_classification", "cleaned_item_names"]
    ordered_cols += [c for c in entree.columns if c not in ordered_cols]
    entree[ordered_cols].to_csv(get_previously_classified_entrees_location(), index=False)

    logger.info(
        (
            "Entree cleaned-name backfill: %d rows (%d kept, %d borrowed from category cache, "
            "%d fell back to product)."
        ),
        n_total,
        n_already,
        n_borrowed,
        n_fallback,
    )
    return {
        "n_total": n_total,
        "n_already": n_already,
        "n_borrowed": n_borrowed,
        "n_fallback": n_fallback,
    }
