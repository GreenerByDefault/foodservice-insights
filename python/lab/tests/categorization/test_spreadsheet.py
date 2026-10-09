from unittest.mock import patch

import pandas as pd
import pytest
from gbd_foodservice_insights.categorization import cache
from gbd_foodservice_insights.categorization.pipeline import CategorizedProducts
from gbd_foodservice_insights.testing import KeywordLlmClient
from gbd_foodservice_insights_lab.categorization import spreadsheet
from gbd_foodservice_insights_lab.categorization.spreadsheet import categorize_spreadsheet_to_csvs


@pytest.fixture(autouse=True)
def absent_cache(tmp_path, monkeypatch):
    """Keeps the developer's local copy of GBD's cache out of these tests."""
    monkeypatch.setattr(cache, "categorization_cache_path", lambda: tmp_path / "absent.csv")


def test_categorize_spreadsheet_to_csvs_writes_human_review_csv(tmp_path):
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

    human_review_df = pd.DataFrame(
        {"category": ["Fruit"], "product": ["apple"], "occurrence_count": [1]}
    )
    categorized = CategorizedProducts(
        cleaned_df=input_df,
        unique_products_df=pd.DataFrame({"product": ["apple"], "category": ["Fruit"]}),
        ai_review_df=human_review_df,
        match_type_counts={"llm": 1},
    )

    with patch.object(spreadsheet, "categorize_unique_products", return_value=categorized):
        _, result_summary = categorize_spreadsheet_to_csvs(
            input_filepath=input_path,
            output_filepath=output_path,
            llm=KeywordLlmClient(),
        )

    expected_review_path = tmp_path / "output_categorized_for_human_review.csv"

    assert output_path.exists()
    assert expected_review_path.exists()
    assert result_summary["human_review_file"] == str(expected_review_path)
    assert result_summary["human_review_n_unique_products"] == 1

    written_review_df = pd.read_csv(expected_review_path)
    pd.testing.assert_frame_equal(written_review_df, human_review_df)


def test_categorize_spreadsheet_to_csvs_raises_for_an_unsupported_file_type(tmp_path):
    input_path = tmp_path / "input.txt"
    input_path.write_text("not real data")

    with pytest.raises(ValueError, match=r"Unsupported file type: \.txt"):
        categorize_spreadsheet_to_csvs(input_filepath=input_path, llm=KeywordLlmClient())


def test_categorize_spreadsheet_to_csvs_raises_for_serving_data_without_a_gemini_client(tmp_path):
    input_path = tmp_path / "input.csv"
    pd.DataFrame({"product": ["apple"], "date": ["2025-01-01"], "weight": [1.0]}).to_csv(
        input_path, index=False
    )

    with pytest.raises(ValueError, match="gemini_client is required for serving data"):
        categorize_spreadsheet_to_csvs(
            input_filepath=input_path, llm=KeywordLlmClient(), data_type="serving"
        )


def test_categorize_spreadsheet_to_csvs_raises_for_an_invalid_data_type(tmp_path):
    input_path = tmp_path / "input.csv"
    pd.DataFrame({"product": ["apple"], "date": ["2025-01-01"], "weight": [1.0]}).to_csv(
        input_path, index=False
    )

    with pytest.raises(ValueError, match=r"Invalid data_type: 'bogus'"):
        categorize_spreadsheet_to_csvs(
            input_filepath=input_path,
            llm=KeywordLlmClient(),
            data_type="bogus",  # ty: ignore[invalid-argument-type]  # Deliberately invalid data_type verifies the runtime check fires.
        )


def test_categorize_spreadsheet_to_csvs_reads_xlsx_input(tmp_path):
    input_path = tmp_path / "input.xlsx"
    output_path = tmp_path / "output_categorized.csv"
    input_df = pd.DataFrame({"product": ["apple"], "date": ["2025-01-01"], "weight": [1.5]})
    input_df.to_excel(input_path, index=False)

    human_review_df = pd.DataFrame(
        {"category": ["Fruit"], "product": ["apple"], "occurrence_count": [1]}
    )
    categorized = CategorizedProducts(
        cleaned_df=input_df,
        unique_products_df=pd.DataFrame({"product": ["apple"], "category": ["Fruit"]}),
        ai_review_df=human_review_df,
        match_type_counts={"llm": 1},
    )

    with patch.object(
        spreadsheet, "categorize_unique_products", return_value=categorized
    ) as mock_categorize_unique_products:
        categorize_spreadsheet_to_csvs(
            input_filepath=input_path,
            output_filepath=output_path,
            llm=KeywordLlmClient(),
        )

    pd.testing.assert_frame_equal(
        mock_categorize_unique_products.call_args.kwargs["df"],
        input_df.assign(date=pd.to_datetime(input_df["date"])),
    )


def test_categorize_spreadsheet_to_csvs_raises_when_weight_cleaning_leaves_missing_values(tmp_path):
    input_path = tmp_path / "input.csv"
    pd.DataFrame({"product": ["apple"], "date": ["2025-01-01"], "weight": ["unknown"]}).to_csv(
        input_path, index=False
    )

    with pytest.raises(ValueError, match="Column 'weight' contains missing values"):
        categorize_spreadsheet_to_csvs(input_filepath=input_path, llm=KeywordLlmClient())


def test_categorize_spreadsheet_to_csvs_raises_for_an_unparseable_date(tmp_path):
    input_path = tmp_path / "input.csv"
    pd.DataFrame({"product": ["apple"], "date": ["not a date"], "weight": [1.0]}).to_csv(
        input_path, index=False
    )

    with pytest.raises(ValueError, match="Date parsing failed for column 'date'"):
        categorize_spreadsheet_to_csvs(input_filepath=input_path, llm=KeywordLlmClient())


def test_categorize_spreadsheet_to_csvs_writes_beside_the_input_by_default(tmp_path):
    input_path = tmp_path / "input.csv"
    input_df = pd.DataFrame({"product": ["apple"], "date": ["2025-01-01"], "weight": [1.0]})
    input_df.to_csv(input_path, index=False)
    categorized = CategorizedProducts(
        cleaned_df=input_df,
        unique_products_df=pd.DataFrame({"product": ["apple"], "category": ["Fruit"]}),
        ai_review_df=pd.DataFrame(),
        match_type_counts={"llm": 1},
    )

    with patch.object(spreadsheet, "categorize_unique_products", return_value=categorized):
        _, result_summary = categorize_spreadsheet_to_csvs(
            input_filepath=input_path, llm=KeywordLlmClient()
        )

    assert result_summary["output_file"] == str(tmp_path / "input_categorized.csv")
    assert (tmp_path / "input_categorized.csv").exists()
