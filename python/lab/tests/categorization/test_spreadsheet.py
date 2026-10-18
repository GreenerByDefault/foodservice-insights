import dataclasses
from unittest.mock import patch

import pandas as pd
import pytest
from gbd_foodservice_insights.categorization.pipeline import CategorizedProducts
from gbd_foodservice_insights.testing import KeywordLlmClient
from gbd_foodservice_insights_lab.categorization import product_cache, spreadsheet
from gbd_foodservice_insights_lab.categorization.spreadsheet import (
    MergeCounts,
    categorize_spreadsheet_to_csvs,
    merge_summary,
)


@pytest.fixture(autouse=True)
def absent_cache(tmp_path, monkeypatch):
    """Keeps the developer's local copy of GBD's cache out of these tests."""
    monkeypatch.setattr(product_cache, "categorization_cache_path", lambda: tmp_path / "absent.csv")


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

    categorized = CategorizedProducts(
        cleaned_df=input_df,
        unique_products_df=pd.DataFrame(
            {"product": ["apple"], "category": ["Fruit"], "match_type": ["llm"]}
        ),
        unrecognized_llm_answers=0,
        new_categorizations=(),
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
        unique_products_df=pd.DataFrame(
            {"product": ["apple"], "category": ["Fruit"], "match_type": ["llm"]}
        ),
        unrecognized_llm_answers=0,
        new_categorizations=(),
    )

    with patch.object(spreadsheet, "categorize_unique_products", return_value=categorized):
        _, result_summary = categorize_spreadsheet_to_csvs(
            input_filepath=input_path, llm=KeywordLlmClient()
        )

    assert result_summary["output_file"] == str(tmp_path / "input_categorized.csv")
    assert (tmp_path / "input_categorized.csv").exists()


def test_merge_counts_between_attributes_every_lost_row_to_categorization():
    before = pd.DataFrame({"product": ["apple", "apple", "towels", "soap", "pear"]})
    after = before.iloc[[0, 1, 4]]

    assert MergeCounts.between(before, after) == MergeCounts(
        n_rows_before=5,
        n_rows_after=3,
        n_products_before=4,
        n_products_after=2,
        n_rows_uncategorized=2,
    )


def test_merge_summary_omits_non_entree_keys_until_the_entree_filter_runs():
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
    assert merge_summary(counts) == expected

    filtered = dataclasses.replace(counts, n_rows_after=4)
    assert merge_summary(filtered, n_rows_non_entree=1) == expected | {
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


def test_merge_summary_avoids_division_by_zero_with_no_rows_before():
    counts = MergeCounts(
        n_rows_before=0,
        n_rows_after=0,
        n_products_before=1,
        n_products_after=1,
        n_rows_uncategorized=0,
    )

    assert merge_summary(counts) == {
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
