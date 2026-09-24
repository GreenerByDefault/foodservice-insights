from unittest.mock import patch

import pandas as pd
from gbd_foodservice_insights.categorization import entrees
from gbd_foodservice_insights.categorization.entrees import (
    classify_entrees_using_historical_classifications,
    run_entree_detector,
)


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


def test_run_entree_detector_escalates_unsure_items_to_pro_marks_review(capsys, tmp_path):
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

    captured = capsys.readouterr().out
    assert "ENTREE CLASSIFICATION SUMMARY" in captured
    assert "Gemini Pro escalations: 1" in captured


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
