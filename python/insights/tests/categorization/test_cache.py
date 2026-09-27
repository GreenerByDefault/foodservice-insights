from pathlib import Path
from unittest.mock import patch

import pandas as pd
from gbd_foodservice_insights.categorization import cache
from gbd_foodservice_insights.categorization.cache import (
    build_cleaned_name_reuse_index,
    categorization_cache_path,
    normalize_product_name,
)


def test_categorization_cache_path():
    path = categorization_cache_path()
    assert isinstance(path, Path)
    assert str(path).endswith("data_files/previously_categorized_items.csv")


def test_get_previously_categorized_items(tmp_path):
    historical_csv_path = tmp_path / "historical.csv"
    expected_df = pd.DataFrame(
        {
            "product": ["test_item", "another_item"],
            "category": ["Test Category", "Another Category"],
            "cleaned_item_names": ["test_item", "another_item"],
        }
    )
    expected_df.to_csv(historical_csv_path, index=False)

    with patch.object(cache, "categorization_cache_path", return_value=historical_csv_path):
        result_df = cache.get_previously_categorized_items()

    pd.testing.assert_frame_equal(result_df, expected_df)


def test_get_previously_categorized_items_returns_empty_when_missing(tmp_path, caplog):
    """Missing cache file logs a warning and returns an empty, correctly-shaped frame."""
    missing_path = tmp_path / "missing.csv"
    with (
        patch.object(cache, "categorization_cache_path", return_value=missing_path),
        caplog.at_level("WARNING"),
    ):
        result = cache.get_previously_categorized_items()

    assert result.empty
    assert list(result.columns) == ["product", "category", "cleaned_item_names"]
    assert "not found" in caplog.text


def test_normalize_product_name_keeps_digits():
    """Normalization lower-cases and collapses punctuation but preserves digits."""
    assert normalize_product_name("7 Up") == "7 up"
    assert normalize_product_name("100% Beef!!") == "100 beef"
    assert normalize_product_name("Chicken  Breast S/less") == "chicken breast s less"
    assert normalize_product_name(pd.NA) == ""


def test_build_cleaned_name_reuse_index_unanimous():
    """Cleaned names with a single agreed canonical category are indexed (case-insensitive)."""
    reviewed = pd.DataFrame(
        {
            "product": ["a", "b"],
            "category": ["Poultry", "Poultry"],
            "cleaned_item_names": ["chicken breast", "Chicken  Breast"],
        }
    )
    with patch.object(cache, "get_GBD_categories", return_value=["Poultry"]):
        index = build_cleaned_name_reuse_index(reviewed)
    assert index == {"chicken breast": "Poultry"}


def test_build_cleaned_name_reuse_index_conflict_excluded():
    """A cleaned name mapping to multiple categories is omitted (left to the LLM)."""
    reviewed = pd.DataFrame(
        {
            "product": ["a", "b"],
            "category": ["Poultry", "Beef"],
            "cleaned_item_names": ["mystery", "mystery"],
        }
    )
    with patch.object(cache, "get_GBD_categories", return_value=["Poultry", "Beef"]):
        index = build_cleaned_name_reuse_index(reviewed)
    assert "mystery" not in index


def test_build_cleaned_name_reuse_index_excludes_no_matches_found():
    """'No Matches Found' is filtered first: it never blocks a real category nor is reused."""
    reviewed = pd.DataFrame(
        {
            "product": ["a", "b", "c", "d"],
            "category": ["No Matches Found", "No Matches Found", "Poultry", "No Matches Found"],
            "cleaned_item_names": ["plate", "plate", "chicken", "chicken"],
        }
    )
    with patch.object(cache, "get_GBD_categories", return_value=["Poultry"]):
        index = build_cleaned_name_reuse_index(reviewed)
    assert "plate" not in index  # only No Matches Found -> excluded
    assert index["chicken"] == "Poultry"  # {Poultry, No Matches Found} -> real category wins


def test_build_cleaned_name_reuse_index_is_empty_without_cleaned_names():
    reviewed = pd.DataFrame({"product": ["a"], "category": ["Poultry"]})
    assert build_cleaned_name_reuse_index(reviewed) == {}
