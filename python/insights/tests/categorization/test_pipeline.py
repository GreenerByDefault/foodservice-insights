from unittest.mock import patch

import pandas as pd
import pytest
from gbd_foodservice_insights.categorization import cache, pipeline, steps
from gbd_foodservice_insights.categorization.pipeline import categorize_file, categorize_products


def test_categorize_products_cache_write_mode_controls_destination():
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
    final_df = pd.DataFrame(
        {"product": ["apple"], "date": ["2025-01-01"], "weight": [1.0], "category": ["Fruit"]}
    )
    summary = {
        "n_products_before": 1,
        "n_products_after": 1,
        "pct_remaining": 1.0,
        "n_rows_before": 1,
        "n_rows_after": 1,
        "row_elimination_details": {},
    }

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
        patch.object(
            pipeline,
            "merge_categorizations",
            return_value=(final_df, summary),
        ),
        patch.object(pipeline, "save_historical_categorizations") as save_reviewed,
        patch.object(
            pipeline,
            "save_unreviewed_web_app_categorizations",
        ) as save_unreviewed,
    ):
        categorize_products(
            df=df,
            openai_client=object(),
            data_type="procurement",
            cache_write_mode="none",
        )
        assert save_reviewed.call_count == 0
        assert save_unreviewed.call_count == 0

        categorize_products(
            df=df,
            openai_client=object(),
            data_type="procurement",
            cache_write_mode="reviewed",
        )
        assert save_reviewed.call_count == 1
        assert save_unreviewed.call_count == 0

        categorize_products(
            df=df,
            openai_client=object(),
            data_type="procurement",
            cache_write_mode="web_app_unreviewed",
        )
        assert save_reviewed.call_count == 1
        assert save_unreviewed.call_count == 1

        with pytest.raises(ValueError, match="Invalid cache_write_mode"):
            categorize_products(
                df=df,
                openai_client=object(),
                data_type="procurement",
                cache_write_mode="invalid-mode",
            )


def test_categorize_products_raises_when_date_cleaning_leaves_missing_values():
    df = pd.DataFrame({"product": ["apple"], "date": ["not a date"], "weight": [1.0]})
    parsed_df = df.copy()
    parsed_df["date"] = pd.NaT

    with (
        patch.object(pipeline, "parse_and_validate_date_column", return_value=parsed_df),
        patch.object(pipeline, "clean_weight_column", return_value=parsed_df),
        pytest.raises(ValueError, match=r"Column 'date' contains NaN values after cleaning."),
    ):
        categorize_products(
            df=df,
            openai_client=object(),
            data_type="procurement",
        )


def test_categorize_products_raises_when_weight_cleaning_leaves_missing_values():
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
        categorize_products(
            df=df,
            openai_client=object(),
            data_type="procurement",
        )


def test_categorize_file_writes_human_review_csv(tmp_path):
    input_path = tmp_path / "input.csv"
    output_path = tmp_path / "output_categorized.csv"
    input_df = pd.DataFrame(
        {
            "product": ["apple"],
            "date": ["2025-01-01"],
            "weight": [1.0],
        }
    )
    input_df.to_csv(input_path, index=False)

    categorized_df = pd.DataFrame(
        {"product": ["apple"], "date": ["2025-01-01"], "weight": [1.0], "category": ["Fruit"]}
    )
    summary = {
        "n_products_before": 1,
        "n_products_after": 1,
        "pct_remaining": 1.0,
        "n_rows_before": 1,
        "n_rows_after": 1,
        "row_elimination_details": {},
    }
    human_review_df = pd.DataFrame(
        {"category": ["Fruit"], "product": ["apple"], "occurrence_count": [1]}
    )

    with patch.object(
        pipeline,
        "categorize_products",
        return_value=(categorized_df, summary, human_review_df),
    ):
        _, result_summary = categorize_file(
            input_filepath=input_path,
            output_filepath=output_path,
            openai_client=object(),
        )

    expected_review_path = tmp_path / "output_categorized_for_human_review.csv"

    assert output_path.exists()
    assert expected_review_path.exists()
    assert result_summary["human_review_file"] == str(expected_review_path)
    assert result_summary["human_review_n_unique_products"] == 1

    written_review_df = pd.read_csv(expected_review_path)
    pd.testing.assert_frame_equal(written_review_df, human_review_df)


def test_categorize_file_writes_entree_human_review_csv(tmp_path):
    input_path = tmp_path / "input.csv"
    output_path = tmp_path / "output_categorized.csv"
    pd.DataFrame(
        {
            "product": ["apple"],
            "date": ["2025-01-01"],
            "weight": [1.0],
        }
    ).to_csv(input_path, index=False)

    categorized_df = pd.DataFrame(
        {"product": ["apple"], "date": ["2025-01-01"], "weight": [1.0], "category": ["Fruit"]}
    )
    summary = {
        "n_products_before": 1,
        "n_products_after": 1,
        "pct_remaining": 1.0,
        "n_rows_before": 1,
        "n_rows_after": 1,
        "row_elimination_details": {},
        "_entree_human_review_df": pd.DataFrame(
            {
                "entree_classification": ["side/add-on"],
                "product": ["apple"],
                "category": ["Fruit"],
                "occurrence_count": [1],
            }
        ),
    }
    human_review_df = pd.DataFrame(
        {"category": ["Fruit"], "product": ["apple"], "occurrence_count": [1]}
    )

    with patch.object(
        pipeline,
        "categorize_products",
        return_value=(categorized_df, summary, human_review_df),
    ):
        _, result_summary = categorize_file(
            input_filepath=input_path,
            output_filepath=output_path,
            openai_client=object(),
            gemini_client=object(),
            data_type="serving",
        )

    expected_review_path = tmp_path / "output_categorized_entree_for_human_review.csv"
    assert expected_review_path.exists()
    assert result_summary["entree_human_review_file"] == str(expected_review_path)
    assert result_summary["entree_human_review_n_unique_products"] == 1


def test_categorize_products_reuses_cleaned_names_and_skips_llm():
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

    categorize_calls = {"n": 0}

    def fake_clean(item, openai_client, max_tokens):
        return "whole milk"

    def fake_categorize(item, categories, openai_client, max_tokens):
        categorize_calls["n"] += 1
        return "No Matches Found"

    empty_web_app = pd.DataFrame(
        columns=["product", "category", "cleaned_item_names", "review_status"]
    )

    with (
        patch.object(steps, "clean_product_name_llm", side_effect=fake_clean),
        patch.object(steps, "match_product_to_category_llm", side_effect=fake_categorize),
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
        df_final, summary, ai_review_df = categorize_products(
            df=df,
            openai_client=object(),
            data_type="procurement",
            historical_categorizations=historical,
            cache_write_mode="none",
        )

    # Both unique products were reused via their cleaned name; the LLM categorizer never ran.
    assert categorize_calls["n"] == 0
    assert summary["match_type_counts"].get("cleaned_name_history") == 2
    assert set(df_final["category"]) == {"Dairy"}
    # Trusted reuse -> nothing queued for human review.
    assert ai_review_df.empty
