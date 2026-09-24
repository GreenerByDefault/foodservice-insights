import shutil
from pathlib import Path
from unittest.mock import patch

import pandas as pd
import pytest
from gbd_foodservice_insights.categorization import cache
from gbd_foodservice_insights.categorization.cache import (
    _historical_cache_path,
    _normalize_product_name,
    backfill_entree_cleaned_names,
    build_cleaned_name_reuse_index,
    get_previously_classified_entrees,
    get_web_app_unreviewed_categorizations,
    promote_local_review_file_to_reviewed_cache,
    promote_reviewed_web_app_categorizations,
    save_historical_categorizations,
    save_historical_entree_classifications,
    save_unreviewed_web_app_categorizations,
)


@pytest.fixture
def temp_test_dir(tmpdir_factory):
    temp_dir = tmpdir_factory.mktemp("test_data")
    yield Path(temp_dir)
    shutil.rmtree(temp_dir)


def test_historical_cache_path():
    path = _historical_cache_path()
    assert isinstance(path, Path)
    assert str(path).endswith("data_files/previously_categorized_items.csv")


def test_get_previously_categorized_items(temp_test_dir):
    historical_csv_path = temp_test_dir / "historical.csv"
    expected_df = pd.DataFrame(
        {
            "product": ["test_item", "another_item"],
            "category": ["Test Category", "Another Category"],
            "cleaned_item_names": ["test_item", "another_item"],
        }
    )
    expected_df.to_csv(historical_csv_path, index=False)

    with patch.object(cache, "_historical_cache_path", return_value=historical_csv_path):
        result_df = cache.get_previously_categorized_items()

    pd.testing.assert_frame_equal(result_df, expected_df)


def test_get_previously_categorized_items_returns_empty_when_missing(tmp_path, caplog):
    """Missing cache file logs a warning and returns an empty, correctly-shaped frame."""
    missing_path = tmp_path / "missing.csv"
    with (
        patch.object(cache, "_historical_cache_path", return_value=missing_path),
        caplog.at_level("WARNING"),
    ):
        result = cache.get_previously_categorized_items()

    assert result.empty
    assert list(result.columns) == ["product", "category", "cleaned_item_names"]
    assert "not found" in caplog.text


def test_get_previously_classified_entrees_returns_empty_when_missing(tmp_path, caplog):
    """Missing entree cache file logs a warning and returns an empty, correctly-shaped frame."""
    missing_path = tmp_path / "missing.csv"
    with (
        patch.object(
            cache,
            "get_previously_classified_entrees_location",
            return_value=missing_path,
        ),
        caplog.at_level("WARNING"),
    ):
        result = get_previously_classified_entrees()

    assert result.empty
    assert list(result.columns) == ["product", "entree_classification", "cleaned_item_names"]
    assert "not found" in caplog.text


def test_expand_historical_categorizations(temp_test_dir):
    """Ensures reviewed labels upsert into history so newer decisions override older ones."""
    initial_historical_data = {
        "product": ["apple", "banana"],
        "category": ["Fruit", "Fruit"],
    }
    initial_historical_df = pd.DataFrame(initial_historical_data)
    historical_csv_path = temp_test_dir / "historical.csv"
    initial_historical_df.to_csv(historical_csv_path, index=False)

    new_data = {
        "product": ["banana", "cherry"],
        "category": ["Tropical Fruit", "Stone Fruit"],
    }
    new_df = pd.DataFrame(new_data)

    with patch.object(
        cache,
        "_historical_cache_path",
        return_value=historical_csv_path,
    ):
        save_historical_categorizations(new_df)

    expanded_df = pd.read_csv(historical_csv_path)

    expected_data = {
        "product": ["apple", "banana", "cherry"],
        "category": ["Fruit", "Tropical Fruit", "Stone Fruit"],
    }
    expected_df = pd.DataFrame(expected_data)
    pd.testing.assert_frame_equal(
        expanded_df.sort_values("product").reset_index(drop=True),
        expected_df.sort_values("product").reset_index(drop=True),
    )


def test_save_historical_categorizations_starts_from_empty_when_missing(tmp_path):
    """First save on a machine without the cache file starts from empty, not a crash."""
    historical_csv_path = tmp_path / "historical.csv"
    new_df = pd.DataFrame({"product": ["apple"], "category": ["Fruit"]})

    with patch.object(cache, "_historical_cache_path", return_value=historical_csv_path):
        save_historical_categorizations(new_df)

    saved = pd.read_csv(historical_csv_path)
    assert saved["product"].tolist() == ["apple"]


def test_save_unreviewed_web_app_categorizations_only_ai_rows(tmp_path):
    unreviewed_cache = tmp_path / "unreviewed.csv"
    new_df = pd.DataFrame(
        {
            "product": ["apple", "banana"],
            "category": ["Fruit", "Fruit"],
            "cleaned_item_names": ["apple", "banana"],
            "previously_categorized": [True, False],
        }
    )

    with patch.object(cache, "_web_app_unreviewed_cache_path", return_value=unreviewed_cache):
        save_unreviewed_web_app_categorizations(new_df)

    saved = pd.read_csv(unreviewed_cache)
    assert saved["product"].tolist() == ["banana"]
    assert saved["review_status"].tolist() == ["pending"]
    assert saved["source"].tolist() == ["web_app"]


def test_get_web_app_unreviewed_categorizations_returns_empty_when_missing(tmp_path):
    unreviewed_cache = tmp_path / "missing_unreviewed.csv"
    with patch.object(cache, "_web_app_unreviewed_cache_path", return_value=unreviewed_cache):
        result = get_web_app_unreviewed_categorizations()
    assert result.empty
    assert "review_status" in result.columns


def test_promote_reviewed_web_app_categorizations_promotes_only_approved(tmp_path):
    """Ensures promotion moves only approved rows into historical cache and tracks reviewer
    metadata.
    """
    historical_cache = tmp_path / "historical.csv"
    unreviewed_cache = tmp_path / "unreviewed.csv"

    pd.DataFrame(
        {"product": ["existing"], "category": ["Fruit"], "cleaned_item_names": ["existing"]}
    ).to_csv(historical_cache, index=False)

    pd.DataFrame(
        {
            "product": ["apple", "banana"],
            "category": ["Fruit", "Vegetables"],
            "cleaned_item_names": ["apple", "banana"],
            "review_status": ["approved", "pending"],
            "review_notes": ["", ""],
            "reviewed_by": ["", ""],
            "reviewed_at": ["", ""],
            "promoted_at": ["", ""],
            "source": ["web_app", "web_app"],
            "created_at": ["2026-01-01T00:00:00", "2026-01-01T00:00:00"],
        }
    ).to_csv(unreviewed_cache, index=False)

    with (
        patch.object(cache, "_historical_cache_path", return_value=historical_cache),
        patch.object(cache, "_web_app_unreviewed_cache_path", return_value=unreviewed_cache),
        patch.object(cache, "get_GBD_categories", return_value=["Fruit", "Vegetables"]),
    ):
        summary = promote_reviewed_web_app_categorizations(reviewed_by_default="reviewer")

    updated_historical = pd.read_csv(historical_cache)
    updated_unreviewed = pd.read_csv(unreviewed_cache)

    assert summary["n_approved"] == 1
    assert summary["n_promoted"] == 1
    assert set(updated_historical["product"]) == {"existing", "apple"}
    assert (
        updated_unreviewed.loc[updated_unreviewed["product"] == "apple", "review_status"].iloc[0]
        == "promoted"
    )
    assert (
        updated_unreviewed.loc[updated_unreviewed["product"] == "apple", "reviewed_by"].iloc[0]
        == "reviewer"
    )
    assert (
        updated_unreviewed.loc[updated_unreviewed["product"] == "apple", "promoted_at"].iloc[0]
        != ""
    )


def test_promote_reviewed_web_app_categorizations_invalid_category_raises(tmp_path):
    historical_cache = tmp_path / "historical.csv"
    unreviewed_cache = tmp_path / "unreviewed.csv"

    pd.DataFrame(
        {"product": ["existing"], "category": ["Fruit"], "cleaned_item_names": ["existing"]}
    ).to_csv(historical_cache, index=False)

    pd.DataFrame(
        {
            "product": ["apple"],
            "category": ["INVALID_CATEGORY"],
            "cleaned_item_names": ["apple"],
            "review_status": ["approved"],
            "review_notes": [""],
            "reviewed_by": [""],
            "reviewed_at": [""],
            "promoted_at": [""],
            "source": ["web_app"],
            "created_at": ["2026-01-01T00:00:00"],
        }
    ).to_csv(unreviewed_cache, index=False)

    with (
        patch.object(cache, "_historical_cache_path", return_value=historical_cache),
        patch.object(cache, "_web_app_unreviewed_cache_path", return_value=unreviewed_cache),
        patch.object(cache, "get_GBD_categories", return_value=["Fruit"]),
        pytest.raises(ValueError, match="invalid categories"),
    ):
        promote_reviewed_web_app_categorizations()


def test_promote_local_review_file_to_reviewed_cache(tmp_path):
    historical_cache = tmp_path / "historical.csv"
    review_file = tmp_path / "local_review.csv"

    pd.DataFrame(
        {"product": ["existing"], "category": ["Fruit"], "cleaned_item_names": ["existing"]}
    ).to_csv(historical_cache, index=False)
    pd.DataFrame({"product": ["apple"], "category": ["Fruit"], "occurrence_count": [3]}).to_csv(
        review_file, index=False
    )

    with (
        patch.object(cache, "_historical_cache_path", return_value=historical_cache),
        patch.object(cache, "get_GBD_categories", return_value=["Fruit"]),
    ):
        summary = promote_local_review_file_to_reviewed_cache(review_file)

    updated_historical = pd.read_csv(historical_cache)
    assert summary["n_rows_promoted"] == 1
    assert set(updated_historical["product"]) == {"existing", "apple"}


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
        cache,
        "get_previously_classified_entrees_location",
        return_value=historical_csv_path,
    ):
        save_historical_entree_classifications(new_df)

    saved = pd.read_csv(historical_csv_path).sort_values("product").reset_index(drop=True)
    assert saved["product"].tolist() == ["apple", "carrot"]
    assert saved["entree_classification"].tolist() == ["side/add-on", "entree"]
    # Schema migration: the entree cache now carries a cleaned-name column.
    assert "cleaned_item_names" in saved.columns


def test_normalize_product_name_keeps_digits():
    """Normalization lower-cases and collapses punctuation but preserves digits."""
    assert _normalize_product_name("7 Up") == "7 up"
    assert _normalize_product_name("100% Beef!!") == "100 beef"
    assert _normalize_product_name("Chicken  Breast S/less") == "chicken breast s less"
    assert _normalize_product_name(pd.NA) == ""


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
        index = build_cleaned_name_reuse_index(reviewed_df=reviewed, include_approved_web_app=False)
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
        index = build_cleaned_name_reuse_index(reviewed_df=reviewed, include_approved_web_app=False)
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
        index = build_cleaned_name_reuse_index(reviewed_df=reviewed, include_approved_web_app=False)
    assert "plate" not in index  # only No Matches Found -> excluded
    assert index["chicken"] == "Poultry"  # {Poultry, No Matches Found} -> real category wins


def test_build_cleaned_name_reuse_index_includes_only_approved_web_app():
    reviewed = pd.DataFrame(columns=["product", "category", "cleaned_item_names"])
    web_app = pd.DataFrame(
        {
            "product": ["x", "y"],
            "category": ["Poultry", "Poultry"],
            "cleaned_item_names": ["duck", "goose"],
            "review_status": ["approved", "pending"],
        }
    )
    with (
        patch.object(cache, "get_web_app_unreviewed_categorizations", return_value=web_app),
        patch.object(cache, "get_GBD_categories", return_value=["Poultry"]),
    ):
        index = build_cleaned_name_reuse_index(reviewed_df=reviewed, include_approved_web_app=True)
    assert index == {"duck": "Poultry"}


def test_get_previously_classified_entrees_backfills_missing_cleaned_column(tmp_path):
    """Loading a pre-migration 2-column entree cache adds an empty cleaned-name column."""
    entree_path = tmp_path / "entree.csv"
    pd.DataFrame({"product": ["apple"], "entree_classification": ["entree"]}).to_csv(
        entree_path, index=False
    )

    with patch.object(
        cache, "get_previously_classified_entrees_location", return_value=entree_path
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
        cache, "get_previously_classified_entrees_location", return_value=entree_path
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
        patch.object(cache, "get_previously_classified_entrees_location", return_value=entree_path),
        patch.object(cache, "_historical_cache_path", return_value=category_path),
    ):
        summary = backfill_entree_cleaned_names()

    saved = pd.read_csv(entree_path).set_index("product")["cleaned_item_names"].to_dict()
    assert saved["apple"] == "green apple"  # borrowed from the category cache
    assert saved["mystery"] == "mystery"  # absent from category cache -> fallback to product
    assert summary["n_borrowed"] == 1
    assert summary["n_fallback"] == 1
