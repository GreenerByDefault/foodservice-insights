import dataclasses
from collections.abc import Sequence
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights.categorization import steps
from gbd_foodservice_insights.categorization.steps import (
    MergeCounts,
    categorize_using_cleaned_name_history,
    categorize_using_historical_classifications,
    categorize_with_llm,
    clean_product_names,
    merge_categorizations,
)
from gbd_foodservice_insights.errors import UnusableDataError
from gbd_foodservice_insights.testing import KeywordLlmClient


# ----------------------------------------------------------------------
# Step 1 — Historical reuse
# ----------------------------------------------------------------------
def test_categorize_using_historical_classifications_loads_the_default_cache():
    historical_df = pd.DataFrame(
        {"product": ["CHEESE CHEDDAR 5LB", "Whole Milk Gallon"], "category": ["Cheese", "Milk"]}
    )
    unique_products_df = pd.DataFrame({"product": ["CHEESE CHEDDAR 5LB", "Paper Towels"]})

    with patch.object(steps, "get_previously_categorized_items", return_value=historical_df):
        result = categorize_using_historical_classifications(unique_products_df)

    pd.testing.assert_frame_equal(
        result,
        pd.DataFrame(
            {
                "product": ["CHEESE CHEDDAR 5LB", "Paper Towels"],
                "category": ["Cheese", np.nan],
                "previously_categorized": [True, False],
                "match_type": pd.Series(["raw_product_history", pd.NA], dtype="object"),
            }
        ),
    )


def test_categorize_using_historical_classifications_prefers_the_latest_history_entry():
    historical_df = pd.DataFrame(
        {"product": ["CHEESE CHEDDAR 5LB"] * 2, "category": ["Butter", "Cheese"]}
    )

    result = categorize_using_historical_classifications(
        pd.DataFrame({"product": ["CHEESE CHEDDAR 5LB"]}), historical_df
    )

    assert result["category"].tolist() == ["Cheese"]


# ----------------------------------------------------------------------
# Step 2 — Name cleaning
# ----------------------------------------------------------------------
def test_clean_product_names_sends_only_uncategorized_products_to_the_llm():
    products_df = pd.DataFrame(
        {
            "product": ["CHEESE CHEDDAR 5LB", "Chicken Breast!!"],
            "category": ["Cheese", np.nan],
            "previously_categorized": [True, False],
        }
    )
    llm = KeywordLlmClient()

    result = clean_product_names(products_df, llm)

    assert llm.calls == [("clean", "Chicken Breast!!")]
    pd.testing.assert_frame_equal(
        result,
        products_df.assign(cleaned_item_names=["CHEESE CHEDDAR 5LB", "chicken breast"]),
    )


def test_clean_product_names_skips_the_llm_when_everything_is_categorized():
    products_df = pd.DataFrame(
        {
            "product": ["CHEESE CHEDDAR 5LB"],
            "category": ["Cheese"],
            "previously_categorized": [True],
        }
    )
    llm = KeywordLlmClient()

    result = clean_product_names(products_df, llm)

    assert llm.calls == []
    pd.testing.assert_frame_equal(
        result, products_df.assign(cleaned_item_names=["CHEESE CHEDDAR 5LB"])
    )


# ----------------------------------------------------------------------
# Step 2.5 — Historical reuse on cleaned names
# ----------------------------------------------------------------------
def test_categorize_using_cleaned_name_history_reuses_a_match_and_trusts_it():
    products_df = pd.DataFrame(
        {
            "product": ["RAW_A", "RAW_B", "RAW_C"],
            "category": ["Cheese", pd.NA, pd.NA],
            "cleaned_item_names": ["cheese", "Chicken  Breast!", "mystery thing"],
            "previously_categorized": [True, False, False],
            "match_type": ["raw_product_history", pd.NA, pd.NA],
        }
    )

    result = categorize_using_cleaned_name_history(
        products_df, reuse_index={"chicken breast": "Poultry (Chicken & Turkey)"}
    )

    pd.testing.assert_frame_equal(
        result,
        products_df.assign(
            category=["Cheese", "Poultry (Chicken & Turkey)", pd.NA],
            previously_categorized=[True, True, False],
            match_type=["raw_product_history", "cleaned_name_history", pd.NA],
        ),
    )


@pytest.mark.parametrize(
    ("category", "reuse_index"),
    [
        pytest.param(pd.NA, {}, id="empty index"),
        pytest.param("Cheese", {"cheese": "Butter"}, id="nothing left to categorize"),
    ],
)
def test_categorize_using_cleaned_name_history_leaves_products_unchanged(category, reuse_index):
    products_df = pd.DataFrame(
        {
            "product": ["RAW_A"],
            "category": [category],
            "cleaned_item_names": ["cheese"],
            "previously_categorized": [pd.notna(category)],
            "match_type": [pd.NA],
        }
    )

    result = categorize_using_cleaned_name_history(products_df, reuse_index=reuse_index)

    pd.testing.assert_frame_equal(result, products_df)


# ----------------------------------------------------------------------
# Step 3 — LLM categorization
# ----------------------------------------------------------------------
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
    pd.testing.assert_frame_equal(
        result,
        products_df.assign(
            category=["Poultry (Chicken & Turkey)"] * 2,
            match_type=pd.Series(["llm"] * 2, dtype="object"),
        ),
    )


def test_categorize_with_llm_skips_the_llm_when_everything_is_already_categorized():
    products_df = pd.DataFrame(
        {
            "product": ["RAW_A"],
            "category": ["Cheese"],
            "cleaned_item_names": ["cheese"],
            "match_type": ["raw_product_history"],
        }
    )
    llm = KeywordLlmClient()

    result = categorize_with_llm(products_df, llm)

    assert llm.calls == []
    pd.testing.assert_frame_equal(result, products_df)


def test_categorize_with_llm_tolerates_a_missing_match_type_column():
    """`match_type` is absent when this step is exercised in isolation of the full pipeline."""
    products_df = pd.DataFrame(
        {
            "product": ["RAW_A"],
            "category": [pd.NA],
            "cleaned_item_names": ["chicken breast"],
        }
    )
    llm = KeywordLlmClient()

    result = categorize_with_llm(products_df, llm)

    assert "match_type" not in result.columns
    pd.testing.assert_frame_equal(
        result, products_df.assign(category=["Poultry (Chicken & Turkey)"])
    )


def test_categorize_with_llm_discards_an_answer_outside_the_gbd_categories():
    class AnswersOffList(KeywordLlmClient):
        def match_product_to_category(self, item: str, categories: Sequence[str]) -> str:
            super().match_product_to_category(item, categories)
            return "Chicken"

    products_df = pd.DataFrame(
        {
            "product": ["RAW_A", "RAW_B"],
            "category": [pd.NA, "Cheese"],
            "cleaned_item_names": ["chicken breast", "cheese"],
            "match_type": [pd.NA, "raw_product_history"],
        }
    )
    llm = AnswersOffList()

    result = categorize_with_llm(products_df, llm)

    assert llm.calls == [("match", "chicken breast")]
    pd.testing.assert_frame_equal(
        result,
        products_df.assign(
            category=["No Matches Found", "Cheese"],
            match_type=["llm", "raw_product_history"],
        ),
    )


# ----------------------------------------------------------------------
# Step 7 — Merge and filter
# ----------------------------------------------------------------------
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

    pd.testing.assert_frame_equal(
        df_final,
        pd.DataFrame(
            {"product": ["product 0"], "date": ["2025-01-01"], "weight": 1.0, "category": "Cheese"}
        ),
    )
    assert counts == MergeCounts(
        n_rows_before=5,
        n_rows_after=1,
        n_products_before=5,
        n_products_after=1,
        n_rows_uncategorized=4,
    )


def test_merge_categorizations_rejects_under_20_percent_remaining_as_unusable():
    with pytest.raises(UnusableDataError, match=r"1/6 \(16\.7%\) remain"):
        _merge_keeping_one_of(6)


def test_merge_categorizations_drops_a_product_missing_from_the_categorizations():
    original_df = pd.DataFrame(
        {
            "product": ["CHEESE CHEDDAR 5LB", "CHEESE CHEDDAR 5LB", "Paper Towels", "Dish Soap"],
            "date": ["2025-01-01"] * 4,
            "weight": [1.0, 2.0, 3.0, 4.0],
        }
    )
    categorized_products_df = pd.DataFrame(
        {
            "product": ["CHEESE CHEDDAR 5LB", "Paper Towels"],
            "category": ["Cheese", "No Matches Found"],
        }
    )

    df_final, counts = merge_categorizations(original_df, categorized_products_df)

    pd.testing.assert_frame_equal(df_final, original_df.head(2).assign(category="Cheese"))
    assert counts == MergeCounts(
        n_rows_before=4,
        n_rows_after=2,
        n_products_before=3,
        n_products_after=1,
        n_rows_uncategorized=2,
    )


def test_merge_categorizations_rejects_empty_input():
    with pytest.raises(ValueError, match="n_products_before is zero"):
        merge_categorizations(
            pd.DataFrame(columns=["product", "date", "weight"]),
            pd.DataFrame(columns=["product", "category"]),
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


def test_merge_counts_to_summary_avoids_division_by_zero_with_no_rows_before():
    counts = MergeCounts(
        n_rows_before=0,
        n_rows_after=0,
        n_products_before=1,
        n_products_after=1,
        n_rows_uncategorized=0,
    )

    assert counts.to_summary() == {
        "n_products_before": 1,
        "n_products_after": 1,
        "pct_remaining": 1.0,
        "n_rows_before": 0,
        "n_rows_after": 0,
        "row_elimination_details": {
            "total_rows_initial": 0,
            "total_rows_final": 0,
            "total_rows_eliminated": 0,
            "total_eliminated_pct": 0,
            "rows_eliminated_uncategorized": 0,
            "rows_eliminated_uncategorized_pct": 0,
        },
    }
