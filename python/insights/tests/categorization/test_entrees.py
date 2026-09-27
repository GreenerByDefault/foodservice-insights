import dataclasses
import logging
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights.categorization import entrees
from gbd_foodservice_insights.categorization.entrees import (
    assign_serving_sizes_from_entree_classification,
    classify_entrees_using_historical_classifications,
    filter_to_entrees,
    run_entree_detector,
)
from gbd_foodservice_insights.categorization.steps import MergeCounts


# ----------------------------------------------------------------------
# classify_entrees_using_historical_classifications
# ----------------------------------------------------------------------
def test_classify_entrees_using_historical_classifications():
    classified_products = pd.DataFrame(
        {
            "product": ["apple", "banana", "plate"],
            "category": ["Fruit", "Fruit", "No Matches Found"],
        }
    )
    historical_df = pd.DataFrame(
        {
            "product": ["apple", "plate"],
            "entree_classification": ["entree", "not entree"],
        }
    )

    result_df = classify_entrees_using_historical_classifications(
        classified_products, historical_df
    )

    result_map = result_df.set_index("product")["entree_classification"].to_dict()
    assert result_map["apple"] == "entree"
    assert pd.isna(result_map["banana"])
    assert result_map["plate"] == "side/add-on"

    prev_map = result_df.set_index("product")["previously_entree_classified"].to_dict()
    assert prev_map == {"apple": True, "banana": False, "plate": True}


def test_classify_entrees_using_historical_classifications_cleaned_name_reuse():
    classified_products = pd.DataFrame(
        {
            "product": ["NEW_RAW"],
            "category": ["Fruit"],
            "cleaned_item_names": ["chicken sandwich"],
        }
    )
    historical_df = pd.DataFrame(
        {
            "product": ["OLD_RAW"],
            "entree_classification": ["entree"],
            "cleaned_item_names": ["Chicken Sandwich"],
        }
    )

    result = classify_entrees_using_historical_classifications(classified_products, historical_df)

    assert result.set_index("product")["entree_classification"].to_dict() == {"NEW_RAW": "entree"}
    assert result.set_index("product")["previously_entree_classified"].to_dict() == {
        "NEW_RAW": True
    }


# ----------------------------------------------------------------------
# run_entree_detector
# ----------------------------------------------------------------------
def test_run_entree_detector_raises_when_product_column_missing(tmp_path):
    with pytest.raises(ValueError, match="must contain a 'product' column"):
        run_entree_detector(
            pd.DataFrame({"category": ["Fruit"]}),
            gemini_client=object(),
            review_sheet_path=tmp_path / "classified_products_with_entree.csv",
        )


def test_run_entree_detector_raises_when_category_column_missing(tmp_path):
    with pytest.raises(ValueError, match="must contain a 'category' column"):
        run_entree_detector(
            pd.DataFrame({"product": ["apple"]}),
            gemini_client=object(),
            review_sheet_path=tmp_path / "classified_products_with_entree.csv",
        )


def test_run_entree_detector_raises_when_a_product_maps_to_multiple_categories(tmp_path):
    classified_products = pd.DataFrame(
        {"product": ["mystery meal", "mystery meal"], "category": ["Fruit", "Dairy"]}
    )

    with (
        patch.object(entrees, "get_GBD_categories", return_value=["Fruit", "Dairy"]),
        pytest.raises(ValueError, match="mystery meal"),
    ):
        run_entree_detector(
            classified_products,
            gemini_client=object(),
            review_sheet_path=tmp_path / "classified_products_with_entree.csv",
        )


def test_run_entree_detector_skips_gemini_when_no_products_are_gbd_eligible(tmp_path):
    """Products dropped upstream as uncategorized never reach the LLM."""
    classified_products = pd.DataFrame(
        {"product": ["paper towels"], "category": ["No Matches Found"]}
    )

    with (
        patch.object(entrees, "get_GBD_categories", return_value=["Fruit"]),
        patch.object(entrees, "call_gemini_api") as mock_call_gemini_api,
        patch("pandas.DataFrame.to_csv"),
    ):
        result_df = run_entree_detector(
            classified_products,
            gemini_client=object(),
            historical_entree_classifications=pd.DataFrame(
                columns=["product", "entree_classification"]
            ),
            review_sheet_path=tmp_path / "classified_products_with_entree.csv",
        )

    mock_call_gemini_api.assert_not_called()
    assert result_df["entree_classification"].isna().all()
    assert result_df["previously_entree_classified"].tolist() == [False]
    assert result_df["entree_used_pro_model"].tolist() == [False]
    assert result_df["entree_needs_review"].tolist() == [False]


def test_run_entree_detector_raises_when_gemini_client_missing_for_new_products(tmp_path):
    classified_products = pd.DataFrame({"product": ["banana"], "category": ["Fruit"]})

    with (
        patch.object(entrees, "get_GBD_categories", return_value=["Fruit"]),
        pytest.raises(ValueError, match="gemini_client must be provided"),
    ):
        run_entree_detector(
            classified_products,
            gemini_client=None,
            historical_entree_classifications=pd.DataFrame(
                columns=["product", "entree_classification"]
            ),
            review_sheet_path=tmp_path / "classified_products_with_entree.csv",
        )


def test_run_entree_detector_uses_historical_before_llm(tmp_path):
    """Ensures the detector only calls the LLM for unseen products, reducing cost and drift."""
    classified_products = pd.DataFrame(
        {
            "product": ["apple", "banana"],
            "category": ["Fruit", "Fruit"],
        }
    )
    historical_df = pd.DataFrame({"product": ["apple"], "entree_classification": ["entree"]})

    gemini_calls = []

    def fake_call_gemini_api(
        prompt,
        gemini_client,
        temperature=0.0,
        model="gemini-3-flash-preview",
    ):
        gemini_calls.append((prompt, model))
        return "side/add-on"

    with (
        patch.object(entrees, "get_GBD_categories", return_value=["Fruit"]),
        patch.object(entrees, "load_prompt", return_value="Prompt"),
        patch.object(entrees, "call_gemini_api", side_effect=fake_call_gemini_api),
        patch.object(entrees, "print_progress", return_value=None),
    ):
        result_df = run_entree_detector(
            classified_products,
            gemini_client=object(),
            historical_entree_classifications=historical_df,
            review_sheet_path=tmp_path / "classified_products_with_entree.csv",
        )

    assert len(gemini_calls) == 1
    assert gemini_calls[0][1] == entrees.ENTREE_FLASH_MODEL
    result_map = result_df.set_index("product")["entree_classification"].to_dict()
    assert result_map == {"apple": "entree", "banana": "side/add-on"}
    assert result_df.set_index("product")["previously_entree_classified"].to_dict() == {
        "apple": True,
        "banana": False,
    }
    assert result_df.set_index("product")["serving_size"].to_dict() == {
        "apple": 1.0,
        "banana": 0.5,
    }


def test_run_entree_detector_retries_transient_gemini_failures_before_succeeding(tmp_path):
    classified_products = pd.DataFrame({"product": ["banana"], "category": ["Fruit"]})
    call_count = 0

    def flaky_call_gemini_api(
        prompt, gemini_client, temperature=0.0, model="gemini-3-flash-preview"
    ):
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            raise RuntimeError("transient failure")
        return "entree"

    with (
        patch.object(entrees, "get_GBD_categories", return_value=["Fruit"]),
        patch.object(entrees, "load_prompt", return_value="Prompt"),
        patch.object(entrees, "call_gemini_api", side_effect=flaky_call_gemini_api),
        patch.object(entrees, "print_progress", return_value=None),
        patch("time.sleep", return_value=None) as mock_sleep,
    ):
        result_df = run_entree_detector(
            classified_products,
            gemini_client=object(),
            historical_entree_classifications=pd.DataFrame(
                columns=["product", "entree_classification"]
            ),
            review_sheet_path=tmp_path / "classified_products_with_entree.csv",
        )

    assert call_count == 3
    assert mock_sleep.call_count == 2
    assert result_df.set_index("product")["entree_classification"].to_dict() == {"banana": "entree"}


def test_run_entree_detector_raises_after_exhausting_gemini_retries(tmp_path):
    classified_products = pd.DataFrame({"product": ["banana"], "category": ["Fruit"]})

    with (
        patch.object(entrees, "get_GBD_categories", return_value=["Fruit"]),
        patch.object(entrees, "load_prompt", return_value="Prompt"),
        patch.object(entrees, "call_gemini_api", side_effect=RuntimeError("persistent failure")),
        patch.object(entrees, "print_progress", return_value=None),
        patch("time.sleep", return_value=None) as mock_sleep,
        pytest.raises(RuntimeError, match="persistent failure"),
    ):
        run_entree_detector(
            classified_products,
            gemini_client=object(),
            historical_entree_classifications=pd.DataFrame(
                columns=["product", "entree_classification"]
            ),
            review_sheet_path=tmp_path / "classified_products_with_entree.csv",
        )

    assert mock_sleep.call_count == entrees.GEMINI_MAX_RETRIES - 1


def test_run_entree_detector_escalates_unsure_items_to_pro_marks_review(caplog, tmp_path):
    """Ensures uncertain first-pass entree labels are escalated and normalized before merge-back."""
    historical_df = pd.DataFrame(columns=["product", "entree_classification"])
    classified_products = pd.DataFrame(
        {
            "product": ["mystery meal", "bean burger"],
            "category": ["Fruit", "Fruit"],
            "cleaned_item_names": ["mystery meal", "bean burger"],
            "quantity": [10, 20],
        }
    )

    gemini_calls = []

    def fake_call_gemini_api(
        prompt,
        gemini_client,
        temperature=0.0,
        model="gemini-3-flash-preview",
    ):
        gemini_calls.append((prompt, model))
        if "mystery meal" in prompt and model == entrees.ENTREE_FLASH_MODEL:
            return "unsure"
        if "mystery meal" in prompt and model == entrees.ENTREE_PRO_MODEL:
            return "side/add-on"
        if "bean burger" in prompt and model == entrees.ENTREE_FLASH_MODEL:
            return "entree"
        raise AssertionError(f"Unexpected prompt/model: {prompt} / {model}")

    with (
        patch.object(entrees, "get_GBD_categories", return_value=["Fruit"]),
        patch.object(entrees, "load_prompt", return_value="Prompt"),
        patch.object(entrees, "call_gemini_api", side_effect=fake_call_gemini_api),
        patch.object(entrees, "print_progress", return_value=None),
        patch("pandas.DataFrame.to_csv") as mock_to_csv,
        caplog.at_level(logging.INFO, logger=entrees.__name__),
    ):
        result_df = run_entree_detector(
            classified_products,
            gemini_client=object(),
            historical_entree_classifications=historical_df,
            review_sheet_path=tmp_path / "classified_products_with_entree.csv",
        )

    assert [model for _, model in gemini_calls] == [
        entrees.ENTREE_FLASH_MODEL,
        entrees.ENTREE_FLASH_MODEL,
        entrees.ENTREE_PRO_MODEL,
    ]
    assert result_df["entree_classification"].tolist() == ["side/add-on", "entree"]
    assert result_df["entree_first_pass_classification"].tolist() == ["unsure", "entree"]
    assert result_df["entree_used_pro_model"].tolist() == [True, False]
    assert result_df["entree_needs_review"].tolist() == [True, False]
    assert result_df["serving_size"].tolist() == [0.5, 1.0]
    assert result_df.loc[0, "entree_review_reason"] == "flash_unsure"
    assert pd.isna(result_df.loc[1, "entree_review_reason"])
    mock_to_csv.assert_called_once()

    assert "ENTREE CLASSIFICATION SUMMARY" in caplog.text
    assert "Gemini Pro escalations: 1" in caplog.text


# ----------------------------------------------------------------------
# assign_serving_sizes_from_entree_classification
# ----------------------------------------------------------------------
def test_assign_serving_sizes_from_entree_classification_maps_known_labels():
    products = pd.DataFrame(
        {
            "product": ["steak", "fries", "water"],
            "entree_classification": ["entree", "side/add-on", pd.NA],
        }
    )

    result = assign_serving_sizes_from_entree_classification(products)

    pd.testing.assert_frame_equal(result, products.assign(serving_size=[1.0, 0.5, np.nan]))


def test_assign_serving_sizes_from_entree_classification_raises_when_column_missing():
    with pytest.raises(ValueError, match="must contain an 'entree_classification' column"):
        assign_serving_sizes_from_entree_classification(pd.DataFrame({"product": ["steak"]}))


def test_assign_serving_sizes_from_entree_classification_raises_on_invalid_label():
    products = pd.DataFrame({"product": ["steak"], "entree_classification": ["unsure"]})

    with pytest.raises(ValueError, match="entree classifications are invalid"):
        assign_serving_sizes_from_entree_classification(products)


# ----------------------------------------------------------------------
# filter_to_entrees
# ----------------------------------------------------------------------
def _merged_rows(products: list[str]) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "product": products,
            "date": ["2025-01-01"] * len(products),
            "weight": 1.0,
            "category": "Fruit",
        }
    )


def test_filter_to_entrees_drops_side_add_ons_and_updates_row_counts():
    # Real entrees, a side, and one product `filter_to_entrees` doesn't recognise at all
    # (e.g. dropped upstream as uncategorized) — its classification is NA, not a label.
    counts = MergeCounts(
        n_rows_before=5,
        n_rows_after=4,
        n_products_before=4,
        n_products_after=3,
        n_rows_uncategorized=1,
    )
    df_final, filtered_counts = filter_to_entrees(
        _merged_rows(["steak", "bread roll", "pot roast", "steak"]),
        counts,
        classified_products=pd.DataFrame(
            {
                "product": ["steak", "bread roll", "pot roast", "unrecognized item"],
                "entree_classification": ["entree", "side/add-on", "entree", pd.NA],
            }
        ),
    )

    pd.testing.assert_frame_equal(
        df_final,
        _merged_rows(["steak", "pot roast", "steak"])
        .set_axis([0, 2, 3])
        .assign(entree_classification="entree"),
    )
    assert filtered_counts == dataclasses.replace(counts, n_rows_after=3, n_rows_non_entree=1)
