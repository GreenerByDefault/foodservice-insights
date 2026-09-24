"""
Integration tests for clean_product_weights module.

These tests validate the weight and unit extraction pipeline using real data
from the previously_classified_weights.csv file as ground truth.

## Testing Strategy for _build_unit_mapping

The `_build_unit_mapping` function internally calls `classify_units_using_historical_weights`,
which pre-populates results for units found in the historical database. This creates a challenge
for testing: if we use real historical data as our ground truth, the function will skip the
LLM extraction logic we want to test.

Our solution:
1. **Mock the historical lookup**: We patch `classify_units_using_historical_weights` to return
   empty results, forcing the function to process all units through the LLM extraction logic.

2. **Mock the LLM functions directly**: We patch `clean_units_llm` and `extract_weight_llm`
   (not the lower-level `call_gemini_api`) to return known-correct values from the historical
   database. This approach is cleaner and more robust than parsing prompts.

3. **Verify correctness**: We compare the function's output against ground truth values from
   the historical database, ensuring the extraction logic works correctly.

This approach allows us to:
- Test the actual LLM extraction code path
- Use real-world data as ground truth
- Verify all edge cases (NaN handling, fallback extraction, post-processing)
- Avoid making real API calls in tests
- Avoid fragile prompt parsing that breaks when prompt files are updated
"""

from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights_lab import clean_product_weights
from gbd_foodservice_insights_lab.clean_product_weights import (
    _build_unit_mapping,
    get_previously_classified_weights,
)

FIXTURE_WEIGHTS_PATH = Path(__file__).parent / "fixtures" / "previously_classified_weights.csv"


@pytest.fixture(autouse=True)
def _use_fixture_weights_csv():
    """Route get_previously_classified_weights() at a small fixture, not the live cache."""
    with patch.object(
        clean_product_weights,
        "get_previously_classified_weights_location",
        return_value=FIXTURE_WEIGHTS_PATH,
    ):
        yield


@pytest.fixture
def sample_ground_truth_units():
    """
    Sample of known-correct unit classifications from historical data.

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


def test_get_previously_classified_weights_returns_empty_when_missing(tmp_path, caplog):
    """Missing cache file logs a warning and returns an empty, correctly-shaped frame."""
    missing_path = tmp_path / "missing.csv"
    with (
        patch.object(
            clean_product_weights,
            "get_previously_classified_weights_location",
            return_value=missing_path,
        ),
        caplog.at_level("WARNING"),
    ):
        result = get_previously_classified_weights()

    assert result.empty
    assert list(result.columns) == [
        "original_unit",
        "llm_cleaned_unit",
        "llm_extracted_weight",
        "example_products",
    ]
    assert "not found" in caplog.text


def test_build_unit_mapping_with_known_units(
    sample_ground_truth_units, mock_df_for_units, mock_gemini_responses
):
    """Integration test for _build_unit_mapping using known-correct units.

    This test: 1. Mocks the historical classification lookup to return empty results
    (forcing the function to use LLM extraction) 2. Mocks clean_units_llm and
    extract_weight_llm directly to return known-correct values 3. Validates that
    _build_unit_mapping correctly processes the units

    The challenge: _build_unit_mapping internally calls
    classify_units_using_historical_weights, which would normally pre-populate results
    from the historical database. We need to bypass this to test the actual LLM
    extraction logic. This matters because unit normalization errors can materially
    distort weight and emissions calculations.
    """
    # Create mock Gemini client
    mock_gemini = MagicMock()

    # Get unique units from our test data
    unique_units = sample_ground_truth_units["original_unit"].values

    # Mock the historical classification to return empty results
    # This forces the function to actually call the LLM for all units
    def mock_classify_historical(unit_mapping_df):
        """Mock that returns no historical matches."""
        unit_mapping_df["previously_classified"] = False
        stats = {
            "total_units": len(unit_mapping_df),
            "matched_units": 0,
            "unmatched_units": len(unit_mapping_df),
            "match_percentage": 0.0,
            "unmatch_percentage": 100.0,
        }
        return unit_mapping_df, stats

    # Mock the LLM functions directly (cleaner than mocking call_gemini_api)
    def mock_clean_units(unit_string, gemini_client):
        """Mock clean_units_llm to return expected cleaned units."""
        return mock_gemini_responses.get(f"clean_unit_{unit_string}", "Unknown or unusable unit")

    def mock_extract_weight(unit_string, gemini_client, custom_prompt=None):
        """Mock extract_weight_llm to return expected weights."""
        return mock_gemini_responses.get(f"extract_weight_{unit_string}", None)

    # Patch the historical lookup and both LLM functions
    with (
        patch(
            "gbd_foodservice_insights_lab.clean_product_weights.classify_units_using_historical_weights",
            side_effect=mock_classify_historical,
        ),
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

    # Mock the historical lookup to return no matches
    def mock_classify_historical(unit_mapping_df):
        unit_mapping_df["previously_classified"] = False
        stats = {
            "total_units": len(unit_mapping_df),
            "matched_units": 0,
            "unmatched_units": len(unit_mapping_df),
            "match_percentage": 0.0,
            "unmatch_percentage": 100.0,
        }
        return unit_mapping_df, stats

    with (
        patch(
            "gbd_foodservice_insights_lab.clean_product_weights.classify_units_using_historical_weights",
            side_effect=mock_classify_historical,
        ),
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

    # Mock the historical lookup to return no matches
    def mock_classify_historical(unit_mapping_df):
        unit_mapping_df["previously_classified"] = False
        stats = {
            "total_units": len(unit_mapping_df),
            "matched_units": 0,
            "unmatched_units": len(unit_mapping_df),
            "match_percentage": 0.0,
            "unmatch_percentage": 100.0,
        }
        return unit_mapping_df, stats

    with (
        patch(
            "gbd_foodservice_insights_lab.clean_product_weights.classify_units_using_historical_weights",
            side_effect=mock_classify_historical,
        ),
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

    # Mock the historical lookup to return no matches
    def mock_classify_historical(unit_mapping_df):
        unit_mapping_df["previously_classified"] = False
        stats = {
            "total_units": len(unit_mapping_df),
            "matched_units": 0,
            "unmatched_units": len(unit_mapping_df),
            "match_percentage": 0.0,
            "unmatch_percentage": 100.0,
        }
        return unit_mapping_df, stats

    with (
        patch(
            "gbd_foodservice_insights_lab.clean_product_weights.classify_units_using_historical_weights",
            side_effect=mock_classify_historical,
        ),
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


def test_10_can_units_in_historical_data():
    """Test that units containing #10 can references are correctly classified as 'oz'.

    #10 cans are a standard size in institutional catering (106 oz capacity). The
    post-processing logic in _build_unit_mapping converts any "10 can" classifications
    to "oz" for consistency. This test verifies: 1. Historical data with #10 can
    references are stored as 'oz' (not "10 can") 2. Weight extraction is correct (e.g.,
    6/#10 CAN = 6 cans × 110 oz = 660 oz) 3. These historical values are correctly used
    by _build_unit_mapping 4. The function doesn't call LLM for units already in
    historical data. This matters because unit normalization errors can materially
    distort weight and emissions calculations.
    """
    # Load actual historical data
    historical = get_previously_classified_weights()

    # Find units that contain #10 can references
    # Based on the historical data, we know these should be classified as 'oz'
    test_cases = [
        {"original_unit": "6/#10 CAN CS", "expected_unit": "oz", "expected_weight": 660.0},
        {"original_unit": "6/#10 CAN BC", "expected_unit": "oz", "expected_weight": 660.0},
        {"original_unit": "6 #10", "expected_unit": "oz", "expected_weight": 660.0},
    ]

    # Verify these units exist in historical data
    for test_case in test_cases:
        hist_row = historical[historical["original_unit"] == test_case["original_unit"]]
        if hist_row.empty:
            # Skip this test case if not in historical data
            continue

        # Verify the historical data has the correct values
        assert hist_row.iloc[0]["llm_cleaned_unit"].lower() == test_case["expected_unit"], (
            f"Historical unit '{test_case['original_unit']}' should be classified as "
            f"'{test_case['expected_unit']}'"
        )

        assert float(hist_row.iloc[0]["llm_extracted_weight"]) == test_case["expected_weight"], (
            f"Historical unit '{test_case['original_unit']}' should have weight "
            f"{test_case['expected_weight']}"
        )

    # Now test that _build_unit_mapping correctly uses these historical values
    test_units = np.array([tc["original_unit"] for tc in test_cases])

    # Create mock DataFrame
    df = pd.DataFrame(
        {"product": [f"Product {i}" for i in range(len(test_units))], "pack_size": test_units}
    )

    mock_gemini = MagicMock()

    # Mock LLM to return wrong values - historical lookup should prevent these from being used
    def mock_clean_units_wrong(unit_string, gemini_client):
        return "WRONG_UNIT"

    def mock_extract_weight_wrong(unit_string, gemini_client, custom_prompt=None):
        return "999.999"

    with (
        patch(
            "gbd_foodservice_insights_lab.clean_product_weights.clean_units_llm",
            side_effect=mock_clean_units_wrong,
        ),
        patch(
            "gbd_foodservice_insights_lab.clean_product_weights.extract_weight_llm",
            side_effect=mock_extract_weight_wrong,
        ),
    ):
        result = _build_unit_mapping(
            unique_units=test_units,
            gemini_client=mock_gemini,
            weight_extraction_instructions=None,
            df=df,
            units_column="pack_size",
            product_name_column="product",
        )

    # Verify each #10 can unit is correctly classified as 'oz' with correct weight
    for test_case in test_cases:
        result_rows = result[result["original_unit"] == test_case["original_unit"]]
        if result_rows.empty:
            continue  # Skip if unit wasn't in test data

        result_row = result_rows.iloc[0]

        # Should be marked as previously classified
        assert result_row["previously_classified"], (
            f"Unit '{test_case['original_unit']}' should be from historical data"
        )

        # Should be classified as 'oz' (not "10 can" or "WRONG_UNIT")
        assert result_row["llm_cleaned_unit"].lower() == test_case["expected_unit"], (
            f"Unit '{test_case['original_unit']}' should be classified as "
            f"'{test_case['expected_unit']}', got '{result_row['llm_cleaned_unit']}'"
        )

        # Should have correct weight from historical data
        assert float(result_row["llm_extracted_weight"]) == test_case["expected_weight"], (
            f"Unit '{test_case['original_unit']}' should have weight "
            f"{test_case['expected_weight']}, got {result_row['llm_extracted_weight']}"
        )


def test_build_unit_mapping_with_historical_data_integration():
    """Integration test that validates _build_unit_mapping works correctly WITH
    historical data (normal operation).

    This test doesn't mock the historical lookup - it tests the actual behavior where
    some units are found in historical data and some need LLM processing. This matters
    because unit normalization errors can materially distort weight and emissions
    calculations.
    """
    # Load actual historical data
    historical = get_previously_classified_weights()

    # Pick some units that ARE in historical data
    known_units = historical["original_unit"].head(5).values

    # And add some that are NOT in historical data
    unknown_units = np.array(["FAKE_UNIT_XYZ", "ANOTHER_FAKE_123"])

    # Combine them
    test_units = np.concatenate([known_units, unknown_units])

    # Create mock DataFrame
    df = pd.DataFrame(
        {"product": [f"Product {i}" for i in range(len(test_units))], "pack_size": test_units}
    )

    # Mock only the LLM functions (not the historical lookup)
    mock_gemini = MagicMock()

    def mock_clean_units(unit_string, gemini_client):
        """Mock clean_units_llm that returns dummy values for unknown units."""
        if "FAKE_UNIT" in unit_string or "ANOTHER_FAKE" in unit_string:
            return "oz"
        return "Unknown or unusable unit"

    def mock_extract_weight(unit_string, gemini_client, custom_prompt=None):
        """Mock extract_weight_llm that returns dummy values for unknown units."""
        if "FAKE_UNIT" in unit_string or "ANOTHER_FAKE" in unit_string:
            return "10.0"
        return None

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
            unique_units=test_units,
            gemini_client=mock_gemini,
            weight_extraction_instructions=None,
            df=df,
            units_column="pack_size",
            product_name_column="product",
        )

    # Validate that historical units were marked as previously_classified
    for unit in known_units:
        row = result[result["original_unit"] == unit].iloc[0]
        assert row["previously_classified"], (
            f"Unit {unit} should be marked as previously classified"
        )
        assert row["llm_cleaned_unit"] is not None, (
            f"Unit {unit} should have a cleaned unit from historical data"
        )

    # Validate that unknown units were processed by LLM
    for unit in unknown_units:
        row = result[result["original_unit"] == unit].iloc[0]
        assert not row["previously_classified"], (
            f"Unit {unit} should NOT be marked as previously classified"
        )
        # These should have been processed by the mocked LLM
        assert row["llm_cleaned_unit"] is not None, f"Unit {unit} should have been processed by LLM"


def test_historical_values_are_actually_used():
    # Load actual historical data
    historical = get_previously_classified_weights()

    # Select a few specific units with known values from historical data
    test_cases = [
        {"original_unit": "48/37 GM", "expected_unit": "g", "expected_weight": 1776.0},
        {"original_unit": "12 LB", "expected_unit": "lb", "expected_weight": 12.0},
        {"original_unit": "15DZ", "expected_unit": "dozen", "expected_weight": 15.0},
    ]

    # Verify these units actually exist in historical data
    for test_case in test_cases:
        hist_row = historical[historical["original_unit"] == test_case["original_unit"]]
        assert not hist_row.empty, (
            f"Unit '{test_case['original_unit']}' should exist in historical data"
        )

    # Extract just the units we're testing
    test_units = np.array([tc["original_unit"] for tc in test_cases])

    # Create mock DataFrame
    df = pd.DataFrame(
        {"product": [f"Product {i}" for i in range(len(test_units))], "pack_size": test_units}
    )

    # Create mock LLM functions that return WRONG values
    # If these values appear in the result, we know historical lookup failed
    mock_gemini = MagicMock()

    def mock_clean_units_wrong(unit_string, gemini_client):
        """Returns WRONG values - should never be used for historical units."""
        return "WRONG_UNIT"

    def mock_extract_weight_wrong(unit_string, gemini_client, custom_prompt=None):
        """Returns WRONG values - should never be used for historical units."""
        return "999.999"

    # Run the function - the historical lookup should prevent LLM calls for these units
    with (
        patch(
            "gbd_foodservice_insights_lab.clean_product_weights.clean_units_llm",
            side_effect=mock_clean_units_wrong,
        ),
        patch(
            "gbd_foodservice_insights_lab.clean_product_weights.extract_weight_llm",
            side_effect=mock_extract_weight_wrong,
        ),
    ):
        result = _build_unit_mapping(
            unique_units=test_units,
            gemini_client=mock_gemini,
            weight_extraction_instructions=None,
            df=df,
            units_column="pack_size",
            product_name_column="product",
        )

    # Verify each unit has the CORRECT historical values, not the mock WRONG values
    for test_case in test_cases:
        result_row = result[result["original_unit"] == test_case["original_unit"]].iloc[0]

        # Should be marked as previously classified
        assert result_row["previously_classified"], (
            f"Unit '{test_case['original_unit']}' should be marked as previously classified"
        )

        # Should have the correct unit from historical data, not "WRONG_UNIT"
        assert result_row["llm_cleaned_unit"] == test_case["expected_unit"], (
            f"Unit '{test_case['original_unit']}' should have cleaned unit "
            f"'{test_case['expected_unit']}' from historical data, "
            f"got '{result_row['llm_cleaned_unit']}'"
        )

        # Should have the correct weight from historical data, not "999.999"
        assert float(result_row["llm_extracted_weight"]) == test_case["expected_weight"], (
            f"Unit '{test_case['original_unit']}' should have weight "
            f"{test_case['expected_weight']} from historical data, "
            f"got {result_row['llm_extracted_weight']}"
        )

        # Verify the mock was NOT called for these units (historical data was used instead)
        assert result_row["llm_cleaned_unit"] != "WRONG_UNIT", (
            f"Unit '{test_case['original_unit']}' incorrectly used mock LLM instead of "
            "historical data"
        )
        assert result_row["llm_extracted_weight"] != "999.999", (
            f"Unit '{test_case['original_unit']}' incorrectly used mock LLM instead of "
            "historical data"
        )


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
