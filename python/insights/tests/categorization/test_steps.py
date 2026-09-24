from unittest.mock import patch

import pandas as pd
from gbd_foodservice_insights.categorization import steps
from gbd_foodservice_insights.categorization.steps import (
    categorize_using_cleaned_name_history,
    categorize_using_historical_classifications,
    categorize_with_llm,
    merge_categorizations,
)


def test_categorize_using_historical_classifications():
    historical_data = {
        "product": ["apple", "banana"],
        "category": ["Fruit", "Fruit"],
    }
    historical_df = pd.DataFrame(historical_data)

    unique_products_data = {"product": ["apple", "cherry", "banana"]}
    unique_products_df = pd.DataFrame(unique_products_data)

    with patch.object(steps, "get_previously_categorized_items", return_value=historical_df):
        result_df = categorize_using_historical_classifications(unique_products_df)

        expected_categories = {"apple": "Fruit", "banana": "Fruit", "cherry": None}
        result_categories = result_df.set_index("product")["category"].to_dict()
        result_categories = {k: v if pd.notna(v) else None for k, v in result_categories.items()}
        assert result_categories == expected_categories

        expected_previously_categorized = {
            "apple": True,
            "banana": True,
            "cherry": False,
        }
        result_previously_categorized = result_df.set_index("product")[
            "previously_categorized"
        ].to_dict()
        assert result_previously_categorized == expected_previously_categorized


def test_merge_categorizations_serving_filters_side_add_on():
    original_df = pd.DataFrame(
        {
            "product": ["apple", "banana", "carrot"],
            "date": ["2025-01-01", "2025-01-01", "2025-01-01"],
            "weight": [1.0, 1.0, 1.0],
        }
    )
    categorized_products_df = pd.DataFrame(
        {
            "product": ["apple", "banana", "carrot"],
            "category": ["Fruit", "Fruit", "Fruit"],
            "entree_classification": ["entree", "side/add-on", "entree"],
        }
    )

    df_final, summary = merge_categorizations(
        original_df=original_df,
        categorized_products_df=categorized_products_df,
        data_type="serving",
        n_products_before=3,
        n_rows_before=3,
    )

    assert sorted(df_final["product"].tolist()) == ["apple", "carrot"]
    assert summary["row_elimination_details"]["rows_eliminated_non_entree"] == 1


def test_categorize_using_cleaned_name_history_reuses_unanimous_match():
    """A still-uncategorized item whose cleaned name is in the reuse index is filled and trusted."""
    products_df = pd.DataFrame(
        {
            "product": ["RAW_A", "RAW_B", "RAW_C"],
            "category": ["Fruit", pd.NA, pd.NA],
            "cleaned_item_names": ["apple", "Chicken  Breast!", "mystery thing"],
            "previously_categorized": [True, False, False],
            "match_type": ["raw_product_history", pd.NA, pd.NA],
        }
    )
    # Index keys are normalized; case/punctuation differences still match.
    reuse_index = {"chicken breast": "Poultry (Chicken & Turkey)"}

    result = categorize_using_cleaned_name_history(products_df, reuse_index=reuse_index)
    by_product = result.set_index("product")

    # RAW_B matched on its cleaned name (case/punctuation-insensitive).
    assert by_product.loc["RAW_B", "category"] == "Poultry (Chicken & Turkey)"
    assert bool(by_product.loc["RAW_B", "previously_categorized"]) is True
    assert by_product.loc["RAW_B", "match_type"] == "cleaned_name_history"

    # RAW_C had no index entry -> left for the LLM.
    assert pd.isna(by_product.loc["RAW_C", "category"])
    assert bool(by_product.loc["RAW_C", "previously_categorized"]) is False
    assert pd.isna(by_product.loc["RAW_C", "match_type"])

    # RAW_A (raw-history hit) is untouched.
    assert by_product.loc["RAW_A", "category"] == "Fruit"
    assert by_product.loc["RAW_A", "match_type"] == "raw_product_history"


def test_categorize_using_cleaned_name_history_noop_without_index():
    products_df = pd.DataFrame(
        {
            "product": ["RAW_A"],
            "category": [pd.NA],
            "cleaned_item_names": ["apple"],
            "previously_categorized": [False],
            "match_type": [pd.NA],
        }
    )
    result = categorize_using_cleaned_name_history(products_df, reuse_index={})
    assert pd.isna(result.loc[0, "category"])


def test_categorize_with_llm_dedupes_identical_cleaned_names():
    products_df = pd.DataFrame(
        {
            "product": ["RAW_A", "RAW_B"],
            "category": [pd.NA, pd.NA],
            "cleaned_item_names": ["chicken breast", "chicken breast"],
            "match_type": [pd.NA, pd.NA],
        }
    )

    call_count = {"n": 0}

    def fake_match(item, categories, openai_client, max_tokens):
        call_count["n"] += 1
        return "Poultry"

    with (
        patch.object(steps, "get_GBD_categories", return_value=["Poultry"]),
        patch.object(steps, "match_product_to_category_llm", side_effect=fake_match),
        patch.object(steps, "print_progress", return_value=None),
    ):
        result = categorize_with_llm(products_df, openai_client=object())

    assert call_count["n"] == 1
    assert result["category"].tolist() == ["Poultry", "Poultry"]
    assert result["match_type"].tolist() == ["llm", "llm"]
