import logging
from collections.abc import Sequence

import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights.categories import category_names
from gbd_foodservice_insights.categorization.cache import NO_MATCHES_FOUND, CategorizationCache
from gbd_foodservice_insights.categorization.steps import (
    categorize_using_cleaned_name_history,
    categorize_using_historical_classifications,
    categorize_with_llm,
    clean_product_names,
    merge_categorizations,
)
from gbd_foodservice_insights.errors import UnusableDataError
from gbd_foodservice_insights.testing import KeywordLlmClient


# ----------------------------------------------------------------------
# Historical reuse
# ----------------------------------------------------------------------
def _cache(
    products: list[str], categories: list[str], cleaned_name_index: dict[str, str] | None = None
) -> CategorizationCache:
    # Built directly: the index is `from_frame`'s job and is tested in test_cache.
    return CategorizationCache(
        products=pd.DataFrame({"product": products, "category": categories}),
        cleaned_name_index=cleaned_name_index or {},
    )


def test_categorize_using_historical_classifications_matches_the_cache():
    cache = _cache(["CHEESE CHEDDAR 5LB", "Whole Milk Gallon"], ["Cheese", "Milk (Cow's milk)"])
    unique_products_df = pd.DataFrame({"product": ["CHEESE CHEDDAR 5LB", "Paper Towels"]})

    result = categorize_using_historical_classifications(unique_products_df, cache)

    pd.testing.assert_frame_equal(
        result,
        pd.DataFrame(
            {
                "product": ["CHEESE CHEDDAR 5LB", "Paper Towels"],
                "category": ["Cheese", np.nan],
                "match_type": pd.Series(["raw_product_history", pd.NA], dtype="object"),
            }
        ),
    )


def test_categorize_using_historical_classifications_prefers_the_latest_history_entry():
    cache = CategorizationCache.from_frame(
        pd.DataFrame(
            {
                "product": ["CHEESE CHEDDAR 5LB"] * 2,
                "category": ["Butter", "Cheese"],
                "cleaned_item_names": ["", ""],
            }
        )
    )

    result = categorize_using_historical_classifications(
        pd.DataFrame({"product": ["CHEESE CHEDDAR 5LB"]}), cache
    )

    assert result["category"].tolist() == ["Cheese"]


def test_categorize_using_historical_classifications_rejects_a_duplicate_cache_product():
    # Only a hand-built cache can hold one; `from_frame` dedupes.
    cache = CategorizationCache(
        products=pd.DataFrame(
            {
                "product": ["CHEESE CHEDDAR 5LB"] * 2,
                "category": ["Butter", "Cheese"],
                "cleaned_item_names": ["", ""],
            }
        ),
        cleaned_name_index={},
    )

    with pytest.raises(pd.errors.MergeError, match="many-to-one"):
        categorize_using_historical_classifications(
            pd.DataFrame({"product": ["CHEESE CHEDDAR 5LB"]}), cache
        )


# ----------------------------------------------------------------------
# Name cleaning
# ----------------------------------------------------------------------
def test_clean_product_names_sends_only_uncategorized_products_to_the_llm():
    products_df = pd.DataFrame(
        {
            "product": ["CHEESE CHEDDAR 5LB", "Chicken Breast!!"],
            "category": ["Cheese", np.nan],
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
        }
    )
    llm = KeywordLlmClient()

    result = clean_product_names(products_df, llm)

    assert llm.calls == []
    pd.testing.assert_frame_equal(
        result, products_df.assign(cleaned_item_names=["CHEESE CHEDDAR 5LB"])
    )


# ----------------------------------------------------------------------
# Historical reuse on cleaned names
# ----------------------------------------------------------------------
def test_categorize_using_cleaned_name_history_reuses_a_match_and_trusts_it():
    products_df = pd.DataFrame(
        {
            "product": ["RAW_A", "RAW_B", "RAW_C"],
            "category": ["Cheese", pd.NA, pd.NA],
            "cleaned_item_names": ["cheese", "Chicken  Breast!", "mystery thing"],
            "match_type": ["raw_product_history", pd.NA, pd.NA],
        }
    )

    cache = _cache([], [], {"chicken breast": "Poultry (Chicken & Turkey)"})

    result = categorize_using_cleaned_name_history(products_df, cache)

    pd.testing.assert_frame_equal(
        result,
        products_df.assign(
            category=["Cheese", "Poultry (Chicken & Turkey)", pd.NA],
            match_type=["raw_product_history", "cleaned_name_history", pd.NA],
        ),
    )


@pytest.mark.parametrize(
    ("category", "cleaned_name_index"),
    [
        pytest.param(pd.NA, {}, id="empty index"),
        pytest.param("Cheese", {"cheese": "Butter"}, id="nothing left to categorize"),
    ],
)
def test_categorize_using_cleaned_name_history_leaves_products_unchanged(
    category, cleaned_name_index
):
    products_df = pd.DataFrame(
        {
            "product": ["RAW_A"],
            "category": [category],
            "cleaned_item_names": ["cheese"],
            "match_type": [pd.NA],
        }
    )

    result = categorize_using_cleaned_name_history(products_df, _cache([], [], cleaned_name_index))

    pd.testing.assert_frame_equal(result, products_df)


# ----------------------------------------------------------------------
# LLM categorization
# ----------------------------------------------------------------------
def test_categorize_with_llm_dedupes_identical_cleaned_names(
    caplog: pytest.LogCaptureFixture,
) -> None:
    products_df = pd.DataFrame(
        {
            "product": ["RAW_A", "RAW_B"],
            "category": [pd.NA, pd.NA],
            "cleaned_item_names": ["chicken breast", "chicken breast"],
            "match_type": [pd.NA, pd.NA],
        }
    )
    llm = KeywordLlmClient()

    result, unrecognized = categorize_with_llm(products_df, llm)

    assert llm.calls == [("match", "chicken breast")]
    pd.testing.assert_frame_equal(
        result,
        products_df.assign(
            category=["Poultry (Chicken & Turkey)"] * 2,
            match_type=pd.Series(["llm"] * 2, dtype="object"),
        ),
    )
    assert unrecognized == 0
    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []


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

    result, unrecognized = categorize_with_llm(products_df, llm)

    assert llm.calls == []
    pd.testing.assert_frame_equal(result, products_df)
    assert unrecognized == 0


def test_categorize_with_llm_resolves_near_misses_and_counts_the_rest(
    caplog: pytest.LogCaptureFixture,
) -> None:
    answers = {
        "oat drink": "Unspecified non-dairy milk.",
        "fried chicken": "Chicken",
        "chicken wings": "Chicken",
        "cheesecake": '"No Matches Found".',
    }

    class Scripted(KeywordLlmClient):
        def match_product_to_category(self, item: str, categories: Sequence[str]) -> str:
            super().match_product_to_category(item, categories)
            return answers[item]

    products_df = pd.DataFrame(
        {
            "product": ["RAW_A", "RAW_B", "RAW_C", "RAW_D", "RAW_E"],
            "category": [pd.NA, pd.NA, pd.NA, pd.NA, "Cheese"],
            "cleaned_item_names": [*answers, "cheese"],
            "match_type": [pd.NA, pd.NA, pd.NA, pd.NA, "raw_product_history"],
        }
    )

    result, unrecognized = categorize_with_llm(products_df, Scripted())

    pd.testing.assert_frame_equal(
        result,
        products_df.assign(
            category=[
                "Unspecified non dairy milk",
                "No Matches Found",
                "No Matches Found",
                "No Matches Found",
                "Cheese",
            ],
            match_type=["llm"] * 4 + ["raw_product_history"],
        ),
    )
    assert unrecognized == 2
    assert [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING] == [
        "2 of 4 LLM answers were not recognized; most common: [('Chicken', 2)]"
    ]


def test_categorize_with_llm_resolves_every_category_named_in_lower_case() -> None:
    # Also fails if a YAML edit gives two categories the same normalized name, which would
    # silently make one of them unreachable.
    categories = [*category_names(), NO_MATCHES_FOUND]

    class LowerCase(KeywordLlmClient):
        def match_product_to_category(self, item: str, categories: Sequence[str]) -> str:
            return item.lower()

    products_df = pd.DataFrame(
        {"category": [pd.NA] * len(categories), "cleaned_item_names": categories}
    )

    result, unrecognized = categorize_with_llm(products_df, LowerCase())

    assert result["category"].tolist() == categories
    assert unrecognized == 0


# ----------------------------------------------------------------------
# Merge and filter
# ----------------------------------------------------------------------
def _merge_keeping_one_of(n_products: int) -> pd.DataFrame:
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
    pd.testing.assert_frame_equal(
        _merge_keeping_one_of(5),
        pd.DataFrame(
            {"product": ["product 0"], "date": ["2025-01-01"], "weight": 1.0, "category": "Cheese"}
        ),
    )


def test_merge_categorizations_rejects_under_20_percent_remaining_as_unusable():
    with pytest.raises(UnusableDataError, match=r"1/6 \(16\.7%\) remain"):
        _merge_keeping_one_of(6)


def test_merge_categorizations_rejects_a_product_missing_from_the_categorizations():
    with pytest.raises(ValueError, match="No categorization for 1 of 2 products"):
        merge_categorizations(
            pd.DataFrame(
                {"product": ["Cheddar", "Paper Towels"], "date": ["2025-01-01"] * 2, "weight": 1.0}
            ),
            pd.DataFrame({"product": ["Cheddar"], "category": ["Cheese"]}),
        )


def test_merge_categorizations_rejects_a_duplicate_categorized_product():
    with pytest.raises(pd.errors.MergeError, match="many-to-one"):
        merge_categorizations(
            pd.DataFrame({"product": ["Cheddar"], "date": ["2025-01-01"], "weight": [1.0]}),
            pd.DataFrame({"product": ["Cheddar"] * 2, "category": ["Cheese", "Butter"]}),
        )


def test_merge_categorizations_rejects_empty_input():
    with pytest.raises(ValueError, match="n_products_before is zero"):
        merge_categorizations(
            pd.DataFrame(columns=["product", "date", "weight"]),
            pd.DataFrame(columns=["product", "category"]),
        )
