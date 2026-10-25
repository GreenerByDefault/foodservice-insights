"""
Tests for the weight and unit extraction pipeline in clean_product_weights.

The LLM calls are mocked at `clean_units_llm` and `extract_weight_llm`, returning known-correct
values, so the tests exercise the extraction code path without the network or prompt parsing.
"""

from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights_lab.clean_product_weights import _build_unit_mapping


@pytest.fixture
def sample_ground_truth_units():
    """
    Sample of known-correct unit classifications.

    These are hand-picked examples covering different unit types:
    - Mass units (lb, oz, g, kg)
    - Volume units (ml, l)
    - Count units (dozen)
    - Complex units (mixed fractions, ranges)
    """
    return pd.DataFrame(
        {
            "original_unit": [
                "48/37 GM",  # grams with count
                "12 LB",  # simple pounds
                "24/125 ML",  # milliliters with count
                "2/5 KGAV",  # kilograms average
                "15DZ",  # dozen
                "36/4OZ",  # ounces with count
                "500 GR",  # grams simple
                "14.5 L",  # liters simple
            ],
            "llm_cleaned_unit": ["g", "lb", "ml", "kg", "dozen", "oz", "g", "l"],
            "llm_extracted_weight": [1776.0, 12.0, 3000.0, 10.0, 15.0, 144.0, 500.0, 14.5],
            "example_products": [
                "SNACK BAR NUTRI MIXED BRY",
                "HOT DOG ROLLER 6 6/LB",
                "ICE CREAM BAR OREO SNDW",
                "HAM BONELESS TOUPIE FRSH",
                "EGG SHELL MED FREE RUN",
                "STEAKETTE SALISBURY 4OZ",
                "500G 2% COT.CHEESE ISLAND FARM",
                "MAYONNAISE HVY W.CANADA",
            ],
        }
    )


@pytest.fixture
def mock_df_for_units(sample_ground_truth_units):
    """
    Create a mock DataFrame that simulates the original purchasing data
    with products that have the units we're testing.
    """
    data = {
        "product": sample_ground_truth_units["example_products"].tolist(),
        "pack_size": sample_ground_truth_units["original_unit"].tolist(),
    }
    return pd.DataFrame(data)


@pytest.fixture
def mock_gemini_responses(sample_ground_truth_units):
    """
    Create a mapping of expected LLM responses for our test units.
    This allows us to mock the Gemini API with known-correct responses.
    """
    responses = {}
    for _, row in sample_ground_truth_units.iterrows():
        unit = row["original_unit"]
        responses[f"clean_unit_{unit}"] = row["llm_cleaned_unit"]
        responses[f"extract_weight_{unit}"] = str(row["llm_extracted_weight"])
    return responses


def test_build_unit_mapping_with_known_units(
    sample_ground_truth_units, mock_df_for_units, mock_gemini_responses
):
    """Unit normalization errors can materially distort weight and emissions calculations."""
    # Create mock Gemini client
    mock_gemini = MagicMock()

    # Get unique units from our test data
    unique_units = sample_ground_truth_units["original_unit"].values

    # Mock the LLM functions directly (cleaner than mocking call_gemini_api)
    def mock_clean_units(unit_string, gemini_client):
        """Mock clean_units_llm to return expected cleaned units."""
        return mock_gemini_responses.get(f"clean_unit_{unit_string}", "Unknown or unusable unit")

    def mock_extract_weight(unit_string, gemini_client, custom_prompt=None):
        """Mock extract_weight_llm to return expected weights."""
        return mock_gemini_responses.get(f"extract_weight_{unit_string}", None)

    # Patch both LLM functions
    with (
        patch(
            "gbd_foodservice_insights_lab.clean_product_weights.clean_units_llm",
            side_effect=mock_clean_units,
        ),
        patch(
            "gbd_foodservice_insights_lab.clean_product_weights.extract_weight_llm",
            side_effect=mock_extract_weight,
        ),
    ):
        result = _build_unit_mapping(
            unique_units=unique_units,
            gemini_client=mock_gemini,
            weight_extraction_instructions=None,
            df=mock_df_for_units,
            units_column="pack_size",
            product_name_column="product",
        )

    # Validate results
    assert len(result) == len(sample_ground_truth_units), "Should return mapping for all units"

    # Check each unit was processed correctly
    for _, expected_row in sample_ground_truth_units.iterrows():
        result_row = result[result["original_unit"] == expected_row["original_unit"]].iloc[0]

        assert result_row["llm_cleaned_unit"] == expected_row["llm_cleaned_unit"], (
            f"Unit '{expected_row['original_unit']}' should be cleaned to "
            f"'{expected_row['llm_cleaned_unit']}', got '{result_row['llm_cleaned_unit']}'"
        )

        assert float(result_row["llm_extracted_weight"]) == float(
            expected_row["llm_extracted_weight"]
        ), (
            f"Unit '{expected_row['original_unit']}' should extract weight "
            f"{expected_row['llm_extracted_weight']}, got {result_row['llm_extracted_weight']}"
        )

        assert result_row["example_products"] is not None, (
            f"Unit '{expected_row['original_unit']}' should have example products"
        )


def test_build_unit_mapping_handles_nan_units(mock_gemini_client):
    # Create test data with NaN unit
    unique_units = np.array(["12 LB", np.nan, "500 GR"], dtype=object)
    df = pd.DataFrame(
        {
            "product": ["Product A", "Product B", "Product C"],
            "pack_size": ["12 LB", np.nan, "500 GR"],
        }
    )

    with (
        patch(
            "gbd_foodservice_insights_lab.clean_product_weights.clean_units_llm",
            return_value="lb",
        ),
        patch(
            "gbd_foodservice_insights_lab.clean_product_weights.extract_weight_llm",
            return_value="12.0",
        ),
    ):
        result = _build_unit_mapping(
            unique_units=unique_units,
            gemini_client=mock_gemini_client,
            weight_extraction_instructions=None,
            df=df,
            units_column="pack_size",
            product_name_column="product",
        )

    # Check that NaN unit has None for both cleaned unit and extracted weight
    # Use pd.isna() to check for NaN in the column first
    nan_rows = result[result["original_unit"].isna()]
    assert len(nan_rows) > 0, "Should have at least one NaN unit"
    nan_row = nan_rows.iloc[0]
    assert pd.isna(nan_row["llm_cleaned_unit"]) or nan_row["llm_cleaned_unit"] is None, (
        "NaN unit should have NaN cleaned_unit"
    )
    assert pd.isna(nan_row["llm_extracted_weight"]) or nan_row["llm_extracted_weight"] is None, (
        "NaN unit should have NaN extracted_weight"
    )


def test_build_unit_mapping_handles_extraction_failures(mock_gemini_client):
    unique_units = np.array(["WEIRD UNIT 123"])
    df = pd.DataFrame({"product": ["Test Product"], "pack_size": ["WEIRD UNIT 123"]})

    with (
        patch(
            "gbd_foodservice_insights_lab.clean_product_weights.clean_units_llm",
            return_value="Unknown or unusable unit",
        ),
        patch(
            "gbd_foodservice_insights_lab.clean_product_weights.extract_weight_llm",
            return_value=None,
        ),
    ):
        result = _build_unit_mapping(
            unique_units=unique_units,
            gemini_client=mock_gemini_client,
            weight_extraction_instructions=None,
            df=df,
            units_column="pack_size",
            product_name_column="product",
        )

    # Verify that failed extraction is marked appropriately
    assert result.iloc[0]["llm_cleaned_unit"] == "Unknown or unusable unit"
    assert (
        pd.isna(result.iloc[0]["llm_extracted_weight"])
        or result.iloc[0]["llm_extracted_weight"] is None
    )


def test_build_unit_mapping_replaces_10_can_with_oz(mock_gemini_client):
    """Test that _build_unit_mapping post-processes '10 can' units to 'oz'.

    This tests the case where the LLM returns "10 can" and it should be automatically
    converted to "oz" by the post-processing logic. This matters because unit
    normalization errors can materially distort weight and emissions calculations.
    """
    unique_units = np.array(["FAKE_10_CAN_UNIT"])
    df = pd.DataFrame({"product": ["Some canned product"], "pack_size": ["FAKE_10_CAN_UNIT"]})

    with (
        patch(
            "gbd_foodservice_insights_lab.clean_product_weights.clean_units_llm",
            return_value="10 can",
        ),
        patch(
            "gbd_foodservice_insights_lab.clean_product_weights.extract_weight_llm",
            return_value="660.0",
        ),
    ):
        result = _build_unit_mapping(
            unique_units=unique_units,
            gemini_client=mock_gemini_client,
            weight_extraction_instructions=None,
            df=df,
            units_column="pack_size",
            product_name_column="product",
        )

    # Verify that "10 can" was replaced with "oz"
    assert result.iloc[0]["llm_cleaned_unit"] == "oz", "10 can should be replaced with oz"


def test_get_example_products():
    from gbd_foodservice_insights_lab.clean_product_weights import _get_example_products

    df = pd.DataFrame(
        {
            "pack_size": ["12 LB", "12 LB", "12 LB", "500 GR", "500 GR"],
            "product": ["Product A", "Product B", "Product C", "Product D", "Product E"],
        }
    )

    # Test with unit that has multiple products
    examples = _get_example_products(df, "pack_size", "12 LB", "product", n=2)
    assert examples is not None
    assert "; " in examples  # Should be semicolon-separated
    assert "Product A" in examples or "Product B" in examples or "Product C" in examples

    # Test with unit that doesn't exist
    examples = _get_example_products(df, "pack_size", "NONEXISTENT", "product")
    assert examples is None

    # Test with limiting to n examples
    examples = _get_example_products(df, "pack_size", "12 LB", "product", n=10)
    assert examples is not None
    parts = examples.split("; ")
    assert len(parts) <= 10  # Should not exceed n


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
