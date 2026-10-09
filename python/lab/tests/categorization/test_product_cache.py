from pathlib import Path
from unittest.mock import patch

import pandas as pd
import pytest
from gbd_foodservice_insights.categorization import cache
from gbd_foodservice_insights_lab.categorization import product_cache
from gbd_foodservice_insights_lab.categorization.product_cache import (
    promote_local_review_file_to_reviewed_cache,
    save_historical_categorizations,
)


def test_save_historical_categorizations_overrides_older_decisions(tmp_path: Path) -> None:
    historical_csv_path = tmp_path / "historical.csv"
    pd.DataFrame({"product": ["apple", "banana"], "category": ["Fruit", "Fruit"]}).to_csv(
        historical_csv_path, index=False
    )
    new_df = pd.DataFrame(
        {"product": ["banana", "cherry"], "category": ["Tropical Fruit", "Stone Fruit"]}
    )

    with patch.object(cache, "categorization_cache_path", return_value=historical_csv_path):
        save_historical_categorizations(new_df)

    pd.testing.assert_frame_equal(
        pd.read_csv(historical_csv_path),
        pd.DataFrame(
            {
                "product": ["apple", "banana", "cherry"],
                "category": ["Fruit", "Tropical Fruit", "Stone Fruit"],
            }
        ),
    )


def test_save_historical_categorizations_keeps_rows_the_loader_drops(tmp_path: Path) -> None:
    historical_csv_path = tmp_path / "historical.csv"
    historical_csv_path.write_text("product,category\n Mlk ,Mlik\n", encoding="utf-8")

    with patch.object(cache, "categorization_cache_path", return_value=historical_csv_path):
        save_historical_categorizations(pd.DataFrame({"product": ["apple"], "category": ["Fruit"]}))

    assert pd.read_csv(historical_csv_path, dtype=str)["product"].tolist() == [" Mlk ", "apple"]


def test_save_historical_categorizations_starts_from_empty_when_missing(tmp_path: Path) -> None:
    historical_csv_path = tmp_path / "historical.csv"
    new_df = pd.DataFrame({"product": ["apple"], "category": ["Fruit"]})

    with patch.object(cache, "categorization_cache_path", return_value=historical_csv_path):
        save_historical_categorizations(new_df)

    assert pd.read_csv(historical_csv_path)["product"].tolist() == ["apple"]


def test_promote_local_review_file_to_reviewed_cache(tmp_path: Path) -> None:
    historical_cache = tmp_path / "historical.csv"
    review_file = tmp_path / "local_review.csv"
    pd.DataFrame(
        {"product": ["existing"], "category": ["Fruit"], "cleaned_item_names": ["existing"]}
    ).to_csv(historical_cache, index=False)
    pd.DataFrame({"product": [" apple "], "category": ["Fruit"], "occurrence_count": [3]}).to_csv(
        review_file, index=False
    )

    with (
        patch.object(cache, "categorization_cache_path", return_value=historical_cache),
        patch.object(product_cache, "get_GBD_categories", return_value=["Fruit"]),
    ):
        summary = promote_local_review_file_to_reviewed_cache(review_file, reviewed_by="reviewer")

    assert summary == {
        "review_file": str(review_file),
        "n_rows_read": 1,
        "n_rows_promoted": 1,
        "reviewed_by": "reviewer",
    }
    pd.testing.assert_frame_equal(
        pd.read_csv(historical_cache),
        pd.DataFrame(
            {
                "product": ["existing", "apple"],
                "category": ["Fruit", "Fruit"],
                "cleaned_item_names": ["existing", None],
            }
        ),
    )


def test_promote_local_review_file_rejects_a_non_canonical_category(tmp_path: Path) -> None:
    historical_cache = tmp_path / "historical.csv"
    review_file = tmp_path / "local_review.csv"
    pd.DataFrame({"product": ["apple"], "category": ["Fruits"]}).to_csv(review_file, index=False)

    with (
        patch.object(cache, "categorization_cache_path", return_value=historical_cache),
        patch.object(product_cache, "get_GBD_categories", return_value=["Fruit"]),
        pytest.raises(ValueError, match=r"Invalid values: \['Fruits'\]"),
    ):
        promote_local_review_file_to_reviewed_cache(review_file)

    assert not historical_cache.exists()
