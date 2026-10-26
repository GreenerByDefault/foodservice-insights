from unittest.mock import patch

import pandas as pd
from gbd_foodservice_insights.categorization.cache import CategorizationCache
from gbd_foodservice_insights_lab.categorization import entree_cache
from gbd_foodservice_insights_lab.categorization.entree_cache import (
    build_entree_cleaned_name_reuse_index,
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
    assert list(result.columns) == ["product", "entree_classification"]
    assert "not found" in caplog.text


def test_get_previously_classified_entrees_keeps_null_like_products_and_drops_cleaned_names(
    tmp_path,
):
    entree_path = tmp_path / "entree.csv"
    entree_path.write_text(
        "product,entree_classification,cleaned_item_names\nNA,entree,\nNone,side/add-on,none\n"
    )

    with patch.object(
        entree_cache, "get_previously_classified_entrees_location", return_value=entree_path
    ):
        df = get_previously_classified_entrees()

    assert df.to_dict("records") == [
        {"product": "NA", "entree_classification": "entree"},
        {"product": "None", "entree_classification": "side/add-on"},
    ]


def test_build_entree_cleaned_name_reuse_index_takes_cleaned_names_from_the_product_cache():
    historical_df = pd.DataFrame(
        {
            "product": [
                "CHKN SAND",
                "Chicken Sandwich Deluxe",
                "Fries Large",
                "Fries Small",
                "Garden Salad",
            ],
            "entree_classification": ["entree", "entree", "side/add-on", "entree", "entree"],
        }
    )
    product_cache = CategorizationCache.from_frame(
        pd.DataFrame(
            {
                "product": ["CHKN SAND", "Chicken Sandwich Deluxe", "Fries Large", "Fries Small"],
                "category": ["Poultry (Chicken & Turkey)"] * 2 + ["No Matches Found"] * 2,
                "cleaned_item_names": ["chicken sandwich", "Chicken Sandwich", "fries", "fries"],
            }
        )
    )

    index = build_entree_cleaned_name_reuse_index(historical_df, product_cache)

    # The fries disagree, so neither is reused; the salad has no row there, so its own name is
    # its key.
    assert index == {"chicken sandwich": "entree", "garden salad": "entree"}
