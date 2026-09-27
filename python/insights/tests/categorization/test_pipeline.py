from unittest.mock import patch

import pandas as pd
import pytest
from gbd_foodservice_insights.categorization import cache, pipeline, steps
from gbd_foodservice_insights.categorization.pipeline import (
    categorize_unique_products,
)
from gbd_foodservice_insights.testing import KeywordLlmClient


def test_categorize_unique_products_cache_write_mode_controls_destination():
    df = pd.DataFrame({"product": ["apple"], "date": ["2025-01-01"], "weight": [1.0]})
    unique_products = pd.DataFrame(
        {
            "product": ["apple"],
            "category": ["Fruit"],
            "previously_categorized": [False],
            "cleaned_item_names": ["apple"],
            "match_type": ["llm"],
        }
    )

    with (
        patch.object(pipeline, "parse_and_validate_date_column", return_value=df),
        patch.object(pipeline, "clean_weight_column", return_value=df),
        patch.object(
            pipeline,
            "get_previously_categorized_items",
            return_value=pd.DataFrame(columns=["product", "category"]),
        ),
        patch.object(
            pipeline,
            "categorize_using_historical_classifications",
            return_value=unique_products,
        ),
        patch.object(pipeline, "clean_product_names", return_value=unique_products),
        patch.object(pipeline, "categorize_with_llm", return_value=unique_products),
        patch.object(
            pipeline,
            "fuzzy_match_GBD_categories",
            return_value=unique_products,
        ),
        patch.object(pipeline, "check_GBD_categories"),
        patch.object(
            pipeline,
            "build_ai_review_table",
            return_value=pd.DataFrame(),
        ),
        patch.object(pipeline, "save_historical_categorizations") as save_reviewed,
        patch.object(
            pipeline,
            "save_unreviewed_web_app_categorizations",
        ) as save_unreviewed,
    ):
        categorize_unique_products(
            df=df,
            llm=KeywordLlmClient(),
            cache_write_mode="none",
        )
        assert save_reviewed.call_count == 0
        assert save_unreviewed.call_count == 0

        categorize_unique_products(
            df=df,
            llm=KeywordLlmClient(),
            cache_write_mode="reviewed",
        )
        assert save_reviewed.call_count == 1
        assert save_unreviewed.call_count == 0

        categorize_unique_products(
            df=df,
            llm=KeywordLlmClient(),
            cache_write_mode="web_app_unreviewed",
        )
        assert save_reviewed.call_count == 1
        assert save_unreviewed.call_count == 1

        with pytest.raises(ValueError, match="Invalid cache_write_mode"):
            categorize_unique_products(
                df=df,
                llm=KeywordLlmClient(),
                cache_write_mode="invalid-mode",
            )


@pytest.mark.parametrize("missing_column", ["product", "date", "weight"])
def test_categorize_unique_products_raises_when_a_required_column_is_missing(missing_column):
    columns = [c for c in ("product", "date", "weight") if c != missing_column]
    df = pd.DataFrame({col: ["x"] for col in columns})

    with pytest.raises(ValueError, match=f"Column '{missing_column}' not found"):
        categorize_unique_products(df=df, llm=KeywordLlmClient())


def test_categorize_unique_products_raises_when_date_cleaning_leaves_missing_values():
    df = pd.DataFrame({"product": ["apple"], "date": ["not a date"], "weight": [1.0]})
    parsed_df = df.copy()
    parsed_df["date"] = pd.NaT

    with (
        patch.object(pipeline, "parse_and_validate_date_column", return_value=parsed_df),
        patch.object(pipeline, "clean_weight_column", return_value=parsed_df),
        pytest.raises(ValueError, match=r"Column 'date' contains NaN values after cleaning."),
    ):
        categorize_unique_products(
            df=df,
            llm=KeywordLlmClient(),
        )


def test_categorize_unique_products_raises_when_weight_cleaning_leaves_missing_values():
    df = pd.DataFrame({"product": ["apple"], "date": ["2025-01-01"], "weight": ["unknown"]})
    parsed_df = df.copy()
    parsed_df["date"] = pd.to_datetime(parsed_df["date"])
    cleaned_df = parsed_df.copy()
    cleaned_df["weight"] = pd.NA

    with (
        patch.object(pipeline, "parse_and_validate_date_column", return_value=parsed_df),
        patch.object(pipeline, "clean_weight_column", return_value=cleaned_df),
        pytest.raises(ValueError, match=r"Column 'weight' contains NaN values after cleaning."),
    ):
        categorize_unique_products(
            df=df,
            llm=KeywordLlmClient(),
        )


def test_categorize_unique_products_reuses_cleaned_names_and_skips_llm():
    df = pd.DataFrame(
        {
            "product": ["MLK WHOLE 2L", "Whole Milk Carton"],
            "date": ["2025-01-01", "2025-01-01"],
            "weight": [1.0, 2.0],
        }
    )
    # Cache holds a *different* raw product whose cleaned name is "whole milk",
    # so the raw lookup misses but the cleaned-name lookup should hit.
    historical = pd.DataFrame(
        {
            "product": ["SOME OTHER MILK SKU"],
            "category": ["Dairy"],
            "cleaned_item_names": ["whole milk"],
        }
    )

    class EverythingIsWholeMilk(KeywordLlmClient):
        def clean_product_name(self, item: str) -> str:
            super().clean_product_name(item)
            return "whole milk"

    llm = EverythingIsWholeMilk()
    empty_web_app = pd.DataFrame(
        columns=["product", "category", "cleaned_item_names", "review_status"]
    )

    with (
        patch.object(steps, "get_GBD_categories", return_value=["Dairy"]),
        patch.object(cache, "get_GBD_categories", return_value=["Dairy"]),
        patch.object(
            cache,
            "get_web_app_unreviewed_categorizations",
            return_value=empty_web_app,
        ),
        patch.object(pipeline, "check_GBD_categories"),
        patch.object(steps, "print_progress", return_value=None),
    ):
        categorized = categorize_unique_products(
            df=df,
            llm=llm,
            historical_categorizations=historical,
            cache_write_mode="none",
        )

    # Both unique products were reused via their cleaned name; the LLM categorizer never ran.
    assert [operation for operation, _ in llm.calls] == ["clean", "clean"]
    assert categorized.match_type_counts.get("cleaned_name_history") == 2
    assert set(categorized.unique_products_df["category"]) == {"Dairy"}
    # Trusted reuse -> nothing queued for human review.
    assert categorized.ai_review_df.empty
