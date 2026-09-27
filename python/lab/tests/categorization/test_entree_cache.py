from unittest.mock import patch

import pandas as pd
from gbd_foodservice_insights.categorization import cache
from gbd_foodservice_insights_lab.categorization import entree_cache
from gbd_foodservice_insights_lab.categorization.entree_cache import (
    backfill_entree_cleaned_names,
    get_previously_classified_entrees,
    save_historical_entree_classifications,
)


def test_get_previously_classified_entrees_returns_empty_when_missing(tmp_path, caplog):
    """Missing entree cache file logs a warning and returns an empty, correctly-shaped frame."""
    missing_path = tmp_path / "missing.csv"
    with (
        patch.object(
            entree_cache,
            "get_previously_classified_entrees_location",
            return_value=missing_path,
        ),
        caplog.at_level("WARNING"),
    ):
        result = get_previously_classified_entrees()

    assert result.empty
    assert list(result.columns) == ["product", "entree_classification", "cleaned_item_names"]
    assert "not found" in caplog.text


def test_save_historical_entree_classifications_uses_main_labels(tmp_path):
    historical_csv_path = tmp_path / "historical_entree.csv"
    pd.DataFrame({"product": ["apple"], "entree_classification": ["entree"]}).to_csv(
        historical_csv_path, index=False
    )

    new_df = pd.DataFrame(
        {
            "product": ["apple", "banana", "carrot"],
            "entree_classification": ["not entree", pd.NA, "entree"],
        }
    )

    with patch.object(
        entree_cache,
        "get_previously_classified_entrees_location",
        return_value=historical_csv_path,
    ):
        save_historical_entree_classifications(new_df)

    saved = pd.read_csv(historical_csv_path).sort_values("product").reset_index(drop=True)
    assert saved["product"].tolist() == ["apple", "carrot"]
    assert saved["entree_classification"].tolist() == ["side/add-on", "entree"]
    # Schema migration: the entree cache now carries a cleaned-name column.
    assert "cleaned_item_names" in saved.columns


def test_get_previously_classified_entrees_backfills_missing_cleaned_column(tmp_path):
    """Loading a pre-migration 2-column entree cache adds an empty cleaned-name column."""
    entree_path = tmp_path / "entree.csv"
    pd.DataFrame({"product": ["apple"], "entree_classification": ["entree"]}).to_csv(
        entree_path, index=False
    )

    with patch.object(
        entree_cache, "get_previously_classified_entrees_location", return_value=entree_path
    ):
        df = get_previously_classified_entrees()
    assert "cleaned_item_names" in df.columns


def test_save_historical_entree_classifications_persists_cleaned_names(tmp_path):
    entree_path = tmp_path / "entree.csv"
    pd.DataFrame(
        {"product": ["apple"], "entree_classification": ["entree"], "cleaned_item_names": ["apple"]}
    ).to_csv(entree_path, index=False)
    new_df = pd.DataFrame(
        {
            "product": ["banana"],
            "entree_classification": ["entree"],
            "cleaned_item_names": ["banana sandwich"],
        }
    )

    with patch.object(
        entree_cache, "get_previously_classified_entrees_location", return_value=entree_path
    ):
        save_historical_entree_classifications(new_df)

    saved = pd.read_csv(entree_path).set_index("product")
    assert saved.loc["banana", "cleaned_item_names"] == "banana sandwich"
    assert saved.loc["apple", "cleaned_item_names"] == "apple"


def test_backfill_entree_cleaned_names_borrows_from_category_cache(tmp_path):
    """Backfill borrows cleaned names from the category cache and falls back to the product."""
    entree_path = tmp_path / "entree.csv"
    category_path = tmp_path / "category.csv"
    pd.DataFrame(
        {"product": ["apple", "mystery"], "entree_classification": ["entree", "side/add-on"]}
    ).to_csv(entree_path, index=False)
    pd.DataFrame(
        {"product": ["apple"], "category": ["Fruit"], "cleaned_item_names": ["green apple"]}
    ).to_csv(category_path, index=False)

    with (
        patch.object(
            entree_cache, "get_previously_classified_entrees_location", return_value=entree_path
        ),
        patch.object(cache, "categorization_cache_path", return_value=category_path),
    ):
        summary = backfill_entree_cleaned_names()

    saved = pd.read_csv(entree_path).set_index("product")["cleaned_item_names"].to_dict()
    assert saved["apple"] == "green apple"  # borrowed from the category cache
    assert saved["mystery"] == "mystery"  # absent from category cache -> fallback to product
    assert summary["n_borrowed"] == 1
    assert summary["n_fallback"] == 1
