from unittest.mock import patch

import pandas as pd
from gbd_foodservice_insights_lab.categorization import entree_cache, product_cache
from gbd_foodservice_insights_lab.categorization.entree_cache import (
    backfill_entree_cleaned_names,
    get_previously_classified_entrees,
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


def test_get_previously_classified_entrees_keeps_null_like_products(tmp_path):
    entree_path = tmp_path / "entree.csv"
    entree_path.write_text(
        "product,entree_classification,cleaned_item_names\nNA,entree,\nNone,side/add-on,none\n"
    )

    with patch.object(
        entree_cache, "get_previously_classified_entrees_location", return_value=entree_path
    ):
        df = get_previously_classified_entrees()

    assert df.astype(object).where(df.notna(), None).to_dict("records") == [
        {"product": "NA", "entree_classification": "entree", "cleaned_item_names": None},
        {"product": "None", "entree_classification": "side/add-on", "cleaned_item_names": "none"},
    ]


def test_backfill_entree_cleaned_names_borrows_from_category_cache(tmp_path):
    """Backfill borrows cleaned names from the category cache and falls back to the product."""
    entree_path = tmp_path / "entree.csv"
    category_path = tmp_path / "category.csv"
    pd.DataFrame(
        {"product": ["apple", "mystery"], "entree_classification": ["entree", "side/add-on"]}
    ).to_csv(entree_path, index=False)
    pd.DataFrame(
        {"product": ["apple"], "category": ["Cheese"], "cleaned_item_names": ["green apple"]}
    ).to_csv(category_path, index=False)

    with (
        patch.object(
            entree_cache, "get_previously_classified_entrees_location", return_value=entree_path
        ),
        patch.object(product_cache, "categorization_cache_path", return_value=category_path),
    ):
        summary = backfill_entree_cleaned_names()

    saved = pd.read_csv(entree_path).set_index("product")["cleaned_item_names"].to_dict()
    assert saved["apple"] == "green apple"  # borrowed from the category cache
    assert saved["mystery"] == "mystery"  # absent from category cache -> fallback to product
    assert summary["n_borrowed"] == 1
    assert summary["n_fallback"] == 1
