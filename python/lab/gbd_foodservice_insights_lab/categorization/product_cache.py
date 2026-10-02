"""
Writes to the product-categorization cache the product reads.

Only reviewed rows belong in it: the product trusts a cache hit outright, keeping it out of the
review table. So these run by hand, after a person has checked a `_for_human_review.csv`.
"""

import logging
from pathlib import Path

import pandas as pd
from gbd_foodservice_insights.categories import get_GBD_categories
from gbd_foodservice_insights.categorization import cache

logger = logging.getLogger(__name__)


def save_historical_categorizations(new_df: pd.DataFrame) -> None:
    """Append reviewed categorizations to the cache; a new row replaces one for the same
    product."""
    # The raw file, not `load_categorization_cache`: a save must not delete the rows the loader
    # drops, which a person may still fix.
    existing = cache.read_categorization_cache_csv()

    cols_to_keep = existing.columns.intersection(new_df.columns)
    combined = pd.concat([existing, new_df[cols_to_keep]], ignore_index=True)
    combined = combined.drop_duplicates(subset=["product"], keep="last")

    combined.to_csv(cache.categorization_cache_path(), index=False)

    logger.info("Historical cache updated: %d unique products.", combined["product"].nunique())


def _validate_categories_for_promotion(df: pd.DataFrame) -> None:
    valid_categories = set(get_GBD_categories())
    invalid_mask = ~df["category"].isin(valid_categories)
    if invalid_mask.any():
        invalid_values = sorted(df.loc[invalid_mask, "category"].astype(str).unique())
        raise ValueError(
            f"Cannot promote rows with invalid categories. Invalid values: {invalid_values}"
        )


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
