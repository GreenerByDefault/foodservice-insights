"""
Categorization Cache & Persistence
====================================

Historical reviewed cache, unreviewed web-app cache, promotion workflows,
and entree history persistence.  Also owns the base entree-label constants
and the label normalizer used during cache I/O.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, cast

import pandas as pd

from gbd_foodservice_insights import PACKAGE_DIR
from gbd_foodservice_insights.categories import get_GBD_categories

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Base entree-label constants (shared across sibling modules)
# ---------------------------------------------------------------------------
ENTREE_LABEL_ENTREE = "entree"
ENTREE_LABEL_SIDE_ADDON = "side/add-on"
ENTREE_LABEL_UNSURE = "unsure"

# ---------------------------------------------------------------------------
# Cache-write-mode constants
# ---------------------------------------------------------------------------
VALID_CACHE_WRITE_MODES = {"none", "reviewed", "web_app_unreviewed"}
UNREVIEWED_WEB_APP_CACHE_COLUMNS = [
    "product",
    "category",
    "cleaned_item_names",
    "review_status",
    "review_notes",
    "reviewed_by",
    "reviewed_at",
    "promoted_at",
    "source",
    "created_at",
]


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------
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


def _first_non_empty_value(values: pd.Series) -> Any:
    """Return the first non-empty value from a Series, or pd.NA if none exist."""
    for value in values:
        if pd.isna(value):
            continue
        if isinstance(value, str) and value.strip() == "":
            continue
        return value
    return pd.NA


def _validate_cache_write_mode(mode: str) -> Literal["none", "reviewed", "web_app_unreviewed"]:
    """Validate cache write mode."""
    if mode not in VALID_CACHE_WRITE_MODES:
        valid = ", ".join(sorted(VALID_CACHE_WRITE_MODES))
        raise ValueError(f"Invalid cache_write_mode: {mode!r}. Expected one of: {valid}.")
    return cast(Literal["none", "reviewed", "web_app_unreviewed"], mode)


def _normalize_product_name(value: Any) -> str:
    """
    Normalize a (cleaned) product name into a match key for cleaned-name reuse.

    Lower-cases, then collapses any run of non-alphanumeric characters to a
    single space and trims.  Digits are deliberately kept — unlike
    ``_normalize_entree_classification``, which strips them — so names such as
    "7 Up" or "100% Beef" keep their numbers.  Returns "" for NaN/empty input.

    The same function is applied to both sides of every cleaned-name match, so
    casing/whitespace/punctuation differences never block a match.
    """
    if pd.isna(value):
        return ""
    text = str(value).strip().lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _unanimous_index(
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
    work["_key"] = work[key_col].map(_normalize_product_name)
    work = work.loc[work["_key"] != ""]
    if work.empty:
        return {}

    distinct_per_key = work.groupby("_key")[value_col].transform("nunique")
    unanimous = work.loc[distinct_per_key == 1].drop_duplicates(subset=["_key"], keep="first")
    return dict(zip(unanimous["_key"], unanimous[value_col], strict=True))


# ----------------------------------------------------------------------
# Reviewed historical cache
# ----------------------------------------------------------------------
def _historical_cache_path() -> Path:
    """Return the path to the historical categorizations CSV."""
    return PACKAGE_DIR / "data_files" / "previously_categorized_items.csv"


def _empty_historical_cache() -> pd.DataFrame:
    """Return an empty DataFrame with the historical cache schema."""
    return pd.DataFrame(columns=["product", "category", "cleaned_item_names"])


def get_previously_categorized_items() -> pd.DataFrame:
    """
    Load the previously categorized items from the cache CSV.

    Returns
    -------
    DataFrame
        Historical categorizations with at least 'product' and 'category' columns.
    """
    path = _historical_cache_path()
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


def save_historical_categorizations(new_df: pd.DataFrame) -> None:
    """
    Append new categorizations to the historical cache and de-duplicate.

    New entries overwrite existing entries for the same product.

    Parameters
    ----------
    new_df : DataFrame
        DataFrame containing new/updated product categorizations.
    """
    path = _historical_cache_path()
    existing = get_previously_categorized_items()

    cols_to_keep = existing.columns.intersection(new_df.columns)
    combined = pd.concat([existing, new_df[cols_to_keep]], ignore_index=True)
    combined = combined.drop_duplicates(subset=["product"], keep="last")

    combined.to_csv(path, index=False)

    logger.info("Historical cache updated: %d unique products.", combined["product"].nunique())


# ----------------------------------------------------------------------
# Unreviewed web-app cache
# ----------------------------------------------------------------------
def _web_app_unreviewed_cache_path() -> Path:
    """Return the path to the unreviewed web-app categorizations CSV."""
    return PACKAGE_DIR / "data_files" / "web_app_categorizations_unreviewed.csv"


def _ensure_unreviewed_cache_schema(df: pd.DataFrame) -> pd.DataFrame:
    """Ensure unreviewed cache has exactly the required schema columns."""
    missing_cols = set(UNREVIEWED_WEB_APP_CACHE_COLUMNS) - set(df.columns)
    if missing_cols:
        raise ValueError(f"Unreviewed cache is missing required columns: {sorted(missing_cols)}")
    normalized = df[UNREVIEWED_WEB_APP_CACHE_COLUMNS].copy()
    for col in UNREVIEWED_WEB_APP_CACHE_COLUMNS:
        normalized[col] = normalized[col].fillna("").astype(str)
    return normalized


def _empty_unreviewed_web_app_cache() -> pd.DataFrame:
    """Return an empty DataFrame with the unreviewed cache schema."""
    return pd.DataFrame(columns=UNREVIEWED_WEB_APP_CACHE_COLUMNS)


def get_web_app_unreviewed_categorizations() -> pd.DataFrame:
    """
    Load unreviewed web-app categorizations.

    Returns
    -------
    DataFrame
        Unreviewed cache rows with fixed schema columns.
    """
    path = _web_app_unreviewed_cache_path()
    if not path.exists():
        logger.info("Unreviewed web-app cache not found at %s; returning empty table.", path)
        return _empty_unreviewed_web_app_cache()

    df = pd.read_csv(path)
    df = _ensure_unreviewed_cache_schema(df)
    logger.info("Loaded %d items from unreviewed web-app cache.", len(df))
    return df


# ----------------------------------------------------------------------
# Cleaned-name reuse index
# ----------------------------------------------------------------------
def _cleaned_name_category_subset(df: pd.DataFrame) -> pd.DataFrame:
    """Return a ``[cleaned_item_names, category]`` frame, or empty if absent."""
    if not {"cleaned_item_names", "category"}.issubset(df.columns):
        return pd.DataFrame(columns=["cleaned_item_names", "category"])
    return df[["cleaned_item_names", "category"]].copy()


def build_cleaned_name_reuse_index(
    reviewed_df: pd.DataFrame | None = None,
    include_approved_web_app: bool = True,
) -> dict[str, str]:
    """
    Build a ``{normalized cleaned name -> GBD category}`` reuse index.

    Sources:
      - the reviewed historical cache (``reviewed_df`` if given — pass the
        already-loaded history to avoid a second read — else the default CSV), and
      - web-app entries whose ``review_status`` is "approved" or "promoted".

    Only canonical GBD categories are eligible ("No Matches Found" and any
    non-canonical label are excluded), and a cleaned name is only included when
    every contributing row agrees on a single category.
    """
    if reviewed_df is None:
        reviewed_df = get_previously_categorized_items()

    frames = [_cleaned_name_category_subset(reviewed_df)]

    if include_approved_web_app:
        web_app_df = get_web_app_unreviewed_categorizations()
        if not web_app_df.empty:
            status = web_app_df["review_status"].fillna("").astype(str).str.strip().str.lower()
            approved = web_app_df.loc[status.isin({"approved", "promoted"})]
            frames.append(_cleaned_name_category_subset(approved))

    combined = pd.concat(frames, ignore_index=True)
    valid_categories = set(get_GBD_categories())
    combined = combined.loc[combined["category"].isin(valid_categories)]

    index = _unanimous_index(combined, key_col="cleaned_item_names", value_col="category")
    logger.info("Built cleaned-name reuse index with %d entries.", len(index))
    return index


def _validate_categories_for_promotion(df: pd.DataFrame) -> None:
    """Fail if any category is not an official GBD category."""
    valid_categories = set(get_GBD_categories())
    invalid_mask = ~df["category"].isin(valid_categories)
    if invalid_mask.any():
        invalid_values = sorted(df.loc[invalid_mask, "category"].astype(str).unique())
        raise ValueError(
            f"Cannot promote rows with invalid categories. Invalid values: {invalid_values}"
        )


def save_unreviewed_web_app_categorizations(
    new_df: pd.DataFrame,
    source: str = "web_app",
) -> None:
    """
    Append AI-only categorizations to unreviewed web-app cache and de-duplicate.

    New entries overwrite existing entries for the same product.
    """
    required_cols = {"product", "category"}
    missing_cols = required_cols - set(new_df.columns)
    if missing_cols:
        raise ValueError(
            f"new_df missing required columns for unreviewed cache save: {sorted(missing_cols)}"
        )

    working = new_df.copy()
    if "previously_categorized" in working.columns:
        working = working.loc[~working["previously_categorized"].fillna(False)].copy()

    if working.empty:
        logger.info("No new AI categorizations to append to unreviewed web-app cache.")
        return

    now = datetime.now().isoformat()
    cleaned_name_col = (
        working["cleaned_item_names"]
        if "cleaned_item_names" in working.columns
        else working["product"]
    )

    pending_rows = pd.DataFrame(
        {
            "product": working["product"].astype(str).str.strip(),
            "category": working["category"].astype(str).str.strip(),
            "cleaned_item_names": cleaned_name_col.fillna(working["product"]).astype(str),
            "review_status": "pending",
            "review_notes": "",
            "reviewed_by": "",
            "reviewed_at": "",
            "promoted_at": "",
            "source": source,
            "created_at": now,
        }
    )

    if pending_rows["product"].eq("").any():
        raise ValueError("Cannot save unreviewed categorizations with empty product values.")
    if pending_rows["category"].eq("").any():
        raise ValueError("Cannot save unreviewed categorizations with empty category values.")

    existing = get_web_app_unreviewed_categorizations()
    combined = pd.concat([existing, pending_rows], ignore_index=True)
    combined = combined.drop_duplicates(subset=["product"], keep="last")
    combined = combined[UNREVIEWED_WEB_APP_CACHE_COLUMNS]

    path = _web_app_unreviewed_cache_path()
    combined.to_csv(path, index=False)
    logger.info(
        "Unreviewed web-app cache updated: %d unique products.",
        combined["product"].nunique(),
    )


# ----------------------------------------------------------------------
# Promotion workflows
# ----------------------------------------------------------------------
def promote_reviewed_web_app_categorizations(
    reviewed_by_default: str | None = None,
) -> dict[str, int]:
    """
    Promote approved rows from unreviewed web-app cache to reviewed cache.

    Approved rows are those with review_status == "approved" (case-insensitive).
    Promoted rows are marked as review_status == "promoted" and stamped with promoted_at.
    """
    unreviewed = get_web_app_unreviewed_categorizations()
    if unreviewed.empty:
        return {
            "n_pending_total": 0,
            "n_approved": 0,
            "n_promoted": 0,
        }

    normalized_status = unreviewed["review_status"].fillna("").astype(str).str.strip().str.lower()
    approved_mask = normalized_status.eq("approved")
    n_approved = int(approved_mask.sum())
    if n_approved == 0:
        return {
            "n_pending_total": int((normalized_status == "pending").sum()),
            "n_approved": 0,
            "n_promoted": 0,
        }

    approved_rows = unreviewed.loc[approved_mask].copy()
    approved_rows["product"] = approved_rows["product"].astype(str).str.strip()
    approved_rows["category"] = approved_rows["category"].astype(str).str.strip()
    if approved_rows["product"].eq("").any():
        raise ValueError("Cannot promote rows with empty product values.")

    _validate_categories_for_promotion(approved_rows)

    if reviewed_by_default:
        empty_reviewer_mask = approved_rows["reviewed_by"].fillna("").astype(str).str.strip().eq("")
        approved_rows.loc[empty_reviewer_mask, "reviewed_by"] = reviewed_by_default
        empty_reviewer_indices = approved_rows.index[empty_reviewer_mask]
        unreviewed.loc[empty_reviewer_indices, "reviewed_by"] = reviewed_by_default

    to_promote = approved_rows[["product", "category", "cleaned_item_names"]].copy()
    save_historical_categorizations(to_promote)

    promoted_at = datetime.now().isoformat()
    unreviewed.loc[approved_mask, "review_status"] = "promoted"
    unreviewed.loc[approved_mask, "promoted_at"] = promoted_at

    path = _web_app_unreviewed_cache_path()
    unreviewed.to_csv(path, index=False)

    return {
        "n_pending_total": int((normalized_status == "pending").sum()),
        "n_approved": n_approved,
        "n_promoted": n_approved,
    }


def promote_local_review_file_to_reviewed_cache(
    review_file: str | Path,
    reviewed_by: str | None = None,
) -> dict[str, int | str]:
    """
    Promote a locally human-reviewed categorization file into reviewed cache.

    Expected columns: product, category. All rows are treated as approved.
    """
    review_file = Path(review_file)
    if not review_file.exists():
        raise FileNotFoundError(f"Review file not found: {review_file}")

    review_df = pd.read_csv(review_file)
    required_cols = {"product", "category"}
    missing_cols = required_cols - set(review_df.columns)
    if missing_cols:
        raise ValueError(f"Review file missing required columns: {sorted(missing_cols)}")

    review_df = review_df.copy()
    review_df["product"] = review_df["product"].astype(str).str.strip()
    review_df["category"] = review_df["category"].astype(str).str.strip()

    if review_df["product"].eq("").any():
        raise ValueError("Review file contains empty product values.")
    if review_df["category"].eq("").any():
        raise ValueError("Review file contains empty category values.")

    _validate_categories_for_promotion(review_df)

    cols_to_save = ["product", "category"]
    if "cleaned_item_names" in review_df.columns:
        cols_to_save.append("cleaned_item_names")
    save_historical_categorizations(review_df[cols_to_save])

    return {
        "review_file": str(review_file),
        "n_rows_read": len(review_df),
        "n_rows_promoted": len(review_df),
        "reviewed_by": reviewed_by or "",
    }


# ----------------------------------------------------------------------
# Entree history persistence
# ----------------------------------------------------------------------
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

    df = pd.read_csv(path)
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
    index = _unanimous_index(work, key_col="cleaned_item_names", value_col="entree_classification")
    logger.info("Built entree cleaned-name reuse index with %d entries.", len(index))
    return index


def save_historical_entree_classifications(new_df: pd.DataFrame) -> None:
    """
    Append new entree classifications to historical data and de-duplicate.
    """
    required_cols = {"product", "entree_classification"}
    missing_cols = required_cols - set(new_df.columns)
    if missing_cols:
        raise ValueError(f"new_df missing required columns for entree save: {sorted(missing_cols)}")

    existing = get_previously_classified_entrees()
    cols_to_save = ["product", "entree_classification"]
    if "cleaned_item_names" in new_df.columns:
        cols_to_save.append("cleaned_item_names")
    valid_rows = new_df.loc[:, cols_to_save].copy()
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
    # Stable column order: product, entree_classification, cleaned_item_names.
    ordered_cols = ["product", "entree_classification"]
    if "cleaned_item_names" in combined.columns:
        ordered_cols.append("cleaned_item_names")
    ordered_cols += [c for c in combined.columns if c not in ordered_cols]
    combined = combined[ordered_cols]
    combined.to_csv(get_previously_classified_entrees_location(), index=False)

    logger.info(
        "Historical entree classifications updated: %d unique products.",
        combined["product"].nunique(),
    )


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

    category = get_previously_categorized_items()
    if "cleaned_item_names" in category.columns:
        name_map = (
            category[["product", "cleaned_item_names"]]
            .dropna(subset=["cleaned_item_names"])
            .drop_duplicates(subset=["product"], keep="last")
        )
    else:
        name_map = pd.DataFrame(columns=["product", "cleaned_item_names"])

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
