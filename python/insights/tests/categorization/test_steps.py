import dataclasses
from unittest.mock import patch

import pandas as pd
import pytest
from gbd_foodservice_insights.categorization import steps
from gbd_foodservice_insights.categorization.steps import (
    MergeCounts,
    categorize_using_cleaned_name_history,
    categorize_using_historical_classifications,
    categorize_with_llm,
    merge_categorizations,
)
from gbd_foodservice_insights.errors import UnusableDataError
from gbd_foodservice_insights.testing import KeywordLlmClient


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


def _merge_keeping_one_of(n_products: int) -> tuple[pd.DataFrame, MergeCounts]:
    products = [f"product {i}" for i in range(n_products)]
    return merge_categorizations(
        original_df=pd.DataFrame(
            {"product": products, "date": ["2025-01-01"] * n_products, "weight": 1.0}
        ),
        categorized_products_df=pd.DataFrame(
            {"product": products, "category": ["Cheese"] + ["No Matches Found"] * (n_products - 1)}
        ),
    )


def test_merge_categorizations_accepts_exactly_20_percent_remaining():
    df_final, counts = _merge_keeping_one_of(5)
    assert df_final["product"].tolist() == ["product 0"]
    assert counts == MergeCounts(
        n_rows_before=5,
        n_rows_after=1,
        n_products_before=5,
        n_products_after=1,
        n_rows_uncategorized=4,
    )


def test_merge_counts_to_summary_omits_non_entree_keys_until_the_entree_filter_runs():
    counts = MergeCounts(
        n_rows_before=8,
        n_rows_after=5,
        n_products_before=5,
        n_products_after=4,
        n_rows_uncategorized=3,
    )
    expected = {
        "n_products_before": 5,
        "n_products_after": 4,
        "pct_remaining": 0.8,
        "n_rows_before": 8,
        "n_rows_after": 5,
        "row_elimination_details": {
            "total_rows_initial": 8,
            "total_rows_final": 5,
            "total_rows_eliminated": 3,
            "total_eliminated_pct": 0.375,
            "rows_eliminated_uncategorized": 3,
            "rows_eliminated_uncategorized_pct": 0.375,
        },
    }
    assert counts.to_summary() == expected

    filtered = dataclasses.replace(counts, n_rows_after=4, n_rows_non_entree=1)
    assert filtered.to_summary() == expected | {
        "n_rows_after": 4,
        "row_elimination_details": expected["row_elimination_details"]
        | {
            "total_rows_final": 4,
            "total_rows_eliminated": 4,
            "total_eliminated_pct": 0.5,
            "rows_eliminated_non_entree": 1,
            "rows_eliminated_non_entree_pct": 0.125,
        },
    }


def test_merge_categorizations_rejects_under_20_percent_remaining_as_unusable():
    with pytest.raises(UnusableDataError, match=r"1/6 \(16\.7%\) remain"):
        _merge_keeping_one_of(6)


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

    llm = KeywordLlmClient()

    result = categorize_with_llm(products_df, llm)

    assert llm.calls == [("match", "chicken breast")]
    assert result["category"].tolist() == ["Poultry (Chicken & Turkey)"] * 2
    assert result["match_type"].tolist() == ["llm", "llm"]
