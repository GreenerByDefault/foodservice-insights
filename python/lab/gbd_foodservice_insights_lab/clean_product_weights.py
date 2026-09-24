import logging
import os
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from gbd_foodservice_insights.utils import print_progress

from gbd_foodservice_insights_lab import PACKAGE_DIR
from gbd_foodservice_insights_lab.extraction.llm import clean_units_llm, extract_weight_llm

logger = logging.getLogger(__name__)


def _is_extraction_failed(row: pd.Series) -> bool:
    """
    Check if unit/weight extraction failed for a given row.

    Args:
        row (pd.Series): A row from the unit_mapping DataFrame.

    Returns:
        bool: True if extraction failed, False otherwise.
    """
    unit_failed = pd.isna(row.get("llm_cleaned_unit")) or row.get("llm_cleaned_unit") in [
        "Unknown or unusable unit",
        "NA",
        "Na",
    ]
    weight_failed = pd.isna(row.get("llm_extracted_weight"))
    return unit_failed or weight_failed


def _get_example_products(
    df: pd.DataFrame, filter_col: str, filter_val: Any, product_col: str, n: int = 5
) -> str | None:
    """
    Get semicolon-separated example products for a given filter value.

    Args:
        df (pd.DataFrame): The DataFrame to filter.
        filter_col (str): Column name to filter on.
        filter_val (Any): Value to filter for.
        product_col (str): Column containing product names.
        n (int): Maximum number of examples to return.

    Returns:
        Optional[str]: Semicolon-separated product names, or None if no examples found.
    """
    filtered = df[df[filter_col] == filter_val]
    if filtered.empty or product_col not in df.columns:
        return None
    examples = filtered[product_col].dropna().unique()[:n]
    return "; ".join(examples) if len(examples) > 0 else None


def check_weight_unit_extraction(
    test_string: str, gemini_client: Any, weight_extraction_instructions: str | None = None
) -> dict[str, str | None]:
    """
    Test function to quickly check what the LLM extracts from a given string.

    This is useful for manual testing and debugging the weight and unit extraction
    without running the full pipeline.

    Args:
        test_string (str): The string to test (e.g., "16 oz", "1 lb 4 oz", "500ml bottle")
        gemini_client (Any): Authenticated client for the Gemini API
        weight_extraction_instructions (Optional[str]): Custom instructions for weight extraction

    Returns:
        Dict[str, Optional[str]]: Dictionary with keys:
            - 'input': The original test string
            - 'cleaned_unit': The cleaned/standardized unit
            - 'extracted_weight': The numerical weight extracted

    Example:
        >>> result = check_weight_unit_extraction("16 oz bottle", gemini_client)
        >>> print(result)
        {'input': '16 oz bottle', 'cleaned_unit': 'oz', 'extracted_weight': '16'}
    """
    result = {"input": test_string, "cleaned_unit": None, "extracted_weight": None}

    # Try to extract cleaned unit
    try:
        result["cleaned_unit"] = clean_units_llm(test_string, gemini_client=gemini_client)
    except Exception as e:
        print(f"Unit extraction failed: {e}")
        result["cleaned_unit"] = f"ERROR: {e}"

    # Try to extract weight
    try:
        result["extracted_weight"] = extract_weight_llm(
            test_string, gemini_client=gemini_client, custom_prompt=weight_extraction_instructions
        )
    except Exception as e:
        print(f"Weight extraction failed: {e}")
        result["extracted_weight"] = f"ERROR: {e}"

    # Print formatted output for interactive testing
    print(
        f"Input: {result['input']:20} → Weight: {result['extracted_weight']}   "
        f"Unit: {result['cleaned_unit']!s:10}"
    )

    return result


def extract_weight_units_pipeline(
    df: pd.DataFrame,
    units_column: str,
    gemini_client: Any,
    weight_extraction_instructions: str | None = None,
    product_name_column: str = "product",
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """
    Processes a DataFrame to clean unit strings and extract weights using a Large Language
    Model (LLM).

    This pipeline function performs the following steps:
    1. Identifies all unique unit strings to avoid duplicate LLM calls.
    2. Uses LLM to clean each unique unit string and extract weight information.
    3. For units where extraction fails, attempts to extract from associated product names.
    4. Creates a mapping table with original units, cleaned units, extracted weights, and
       example products.
    5. Sorts the mapping table for easier review and debugging.
    6. Saves the mapping table to 'cleaned_units_extracted_weights.csv'.

    Args:
        df (pd.DataFrame): The input DataFrame containing product and unit information.
        units_column (str): Name of the column containing unit strings to be processed.
            Examples: "16 oz", "1 lb 4 oz", "500ml bottle"
    gemini_client (Any): Authenticated client for the Gemini API used to call the LLM.
        weight_extraction_instructions (Optional[str]): Custom instructions for the LLM
            when extracting weights. If None, uses default prompt from file.
        product_name_column (str): Name of the column containing product names.
            Used as a fallback when unit extraction fails. Default is "product".

    Returns:
        Tuple[pd.DataFrame, Dict]: A tuple containing:
            - pd.DataFrame: A mapping table with columns:
                - original_unit: The original unit string from the input data
                - llm_cleaned_unit: Cleaned/standardized unit (e.g., "oz", "lb", "ml")
                - llm_extracted_weight: Numerical weight extracted from unit string
                - example_products: Up to 5 example products with this unit (for review)
                - previously_classified: Boolean indicating if from historical database
            - Dict: Summary statistics with keys:
                - 'total_units': Total number of unique units processed
                - 'nan_units': Units with NaN cleaned values
                - 'unknown_units': Units marked as 'Unknown or unusable'
                - 'nan_weights': Weights with NaN extracted values
                - 'previously_classified': Units found in historical data
                - 'success_rate': Percentage of successful extractions

    Side Effects:
        - Prints progress information about the number of unique units being processed.
        - May print warnings or errors for individual units that couldn't be processed.

    Note:
        The function is designed to be efficient by processing each unique unit string only once,
        regardless of how many times it appears in the dataset. Large datasets with many
        duplicate units will benefit significantly from this approach.

        The returned DataFrame is a mapping table, not the original DataFrame with merged columns.
        To merge results back into your original DataFrame, use the mapping DataFrame with a join.

    Example Workflow:
        >>> # Step 1: Run pipeline
        >>> weights, stats = extract_weight_units_pipeline(
        ...     df=df_missing_weights,
        ...     units_column="pack_size",
        ...     gemini_client=client
        ... )
        >>>
        >>> # Step 2: Optionally save for manual review
        >>> weights.to_csv("cleaned_units_extracted_weights.csv", index=False)
        >>>
        >>> # Step 3: Fix any errors and reload if needed
        >>> weights = pd.read_csv("hand_cleaned_units_extracted_weights.csv")
        >>>
        >>> # Step 4: Merge back to original dataframe
        >>> df = df.merge(weights, left_on="pack_size", right_on="original_unit")
        >>>
        >>> # Step 5: Update historical database for future use
        >>> expand_historical_weight_classifications(weights)
    """
    # Validate input parameters to catch common errors early
    if units_column not in df.columns:
        raise ValueError(f"Column '{units_column}' not found in DataFrame")
    if product_name_column not in df.columns:
        raise ValueError(f"Column '{product_name_column}' not found in DataFrame")

    # Step 1: Extract unique unit strings to minimize LLM API calls
    # This is crucial for efficiency - we only process each unique unit once
    unique_units = _get_unique_units(df, units_column)
    print(f"Found {len(unique_units)} unique units to process.")

    # Step 2: Process each unique unit with LLM to clean and extract weights
    # This creates a mapping table that we'll use to update all matching rows
    unit_mapping = _build_unit_mapping(
        unique_units,
        gemini_client,
        weight_extraction_instructions,
        df,
        units_column,
        product_name_column,
    )

    # Step 3: Sort the mapping table for better readability and debugging
    # Sort by: previously_classified (False first), then cleaned unit, then original_unit
    unit_mapping_sorted = unit_mapping.sort_values(
        by=["previously_classified", "llm_cleaned_unit", "original_unit"],
        ascending=[True, True, True],
        na_position="first",
    ).reset_index(drop=True)

    # Step 4: Generate extraction summary statistics
    n_nan_units = unit_mapping_sorted["llm_cleaned_unit"].isna().sum()
    n_nan_weights = unit_mapping_sorted["llm_extracted_weight"].isna().sum()
    n_unknown_units = (unit_mapping_sorted["llm_cleaned_unit"] == "Unknown or unusable unit").sum()
    n_previously_classified = unit_mapping_sorted["previously_classified"].sum()
    success_rate = (
        ((len(unique_units) - n_nan_weights) / len(unique_units) * 100)
        if len(unique_units) > 0
        else 0
    )

    summary_stats = {
        "total_units": len(unique_units),
        "nan_units": n_nan_units,
        "unknown_units": n_unknown_units,
        "nan_weights": n_nan_weights,
        "previously_classified": n_previously_classified,
        "success_rate": success_rate,
    }

    print("\nExtraction Summary:")
    print(f"  - Total unique units processed: {summary_stats['total_units']}")
    print(f"  - Units with NaN cleaned values: {summary_stats['nan_units']}")
    print(f"  - Units marked as 'Unknown or unusable': {summary_stats['unknown_units']}")
    print(f"  - Weights with NaN extracted values: {summary_stats['nan_weights']}")
    print(f"  - Success rate: {summary_stats['success_rate']:.1f}%")

    if n_previously_classified == len(unique_units):
        print("\n✓ All units were found in historical data. No new classifications needed.")

    return unit_mapping_sorted, summary_stats


def _get_unique_units(df: pd.DataFrame, units_column: str) -> np.ndarray:
    """
    Gets the unique units from the DataFrame.

    Args:
        df (pd.DataFrame): The input DataFrame.
        units_column (str): The name of the column containing the units.

    Returns:
        np.ndarray: A numpy array of unique units.
    """
    # Validate input columns
    if units_column not in df.columns:
        raise ValueError(f"Column '{units_column}' not found in DataFrame")

    return df[units_column].unique()


def _build_unit_mapping(
    unique_units: np.ndarray,
    gemini_client: Any,
    weight_extraction_instructions: str | None,
    df: pd.DataFrame,
    units_column: str,
    product_name_column: str,
) -> pd.DataFrame:
    """
    Builds a mapping from original units to cleaned units and extracted weights using an LLM.

    Args:
        unique_units (np.ndarray): An array of unique unit strings.
        gemini_client (Any): The client for the Gemini API.
        weight_extraction_instructions (Optional[str]): Custom instructions for weight extraction.
        df (pd.DataFrame): The original DataFrame to sample product names from.
        units_column (str): The name of the column containing unit strings.
        product_name_column (str): The name of the column containing product names.

    Returns:
        pd.DataFrame: A DataFrame with columns 'original_unit', 'llm_cleaned_unit',
                      'llm_extracted_weight', and 'example_products'.
    """
    # Validate input columns
    if units_column not in df.columns:
        raise ValueError(f"Column '{units_column}' not found in DataFrame")
    if product_name_column not in df.columns:
        raise ValueError(f"Column '{product_name_column}' not found in DataFrame")

    unit_mapping = pd.DataFrame(
        columns=["original_unit", "llm_cleaned_unit", "llm_extracted_weight", "example_products"]
    )  # make a blank dfto hold the data
    unit_mapping["original_unit"] = unique_units

    # First, try to classify using historical data
    print("\n" + "=" * 60)
    print("CHECKING HISTORICAL WEIGHT CLASSIFICATIONS")
    print("=" * 60)
    unit_mapping, overlap_stats = classify_units_using_historical_weights(unit_mapping)

    # Print overlap statistics
    print("\nDataset Overview:")
    print(f"  • Total unique units in current dataset: {overlap_stats['total_units']}")
    print(
        f"  • Units found in historical data: {overlap_stats['matched_units']} "
        f"({overlap_stats['match_percentage']:.1f}%)"
    )
    print(
        f"  • Units requiring LLM processing: {overlap_stats['unmatched_units']} "
        f"({overlap_stats['unmatch_percentage']:.1f}%)"
    )
    print("=" * 60 + "\n")

    # Count how many units still need processing
    mask_needs_processing = unit_mapping["llm_cleaned_unit"].isna()
    num_to_process = mask_needs_processing.sum()
    print(
        f"Processing {num_to_process} out of {len(unique_units)} units using LLM "
        "(rest found in historical data)"
    )

    # Process all units to get example products
    for progress_index, (idx, row) in enumerate(unit_mapping.iterrows(), start=1):
        # Print progress for all units
        print_progress("Processing units with LLM", progress_index, len(unit_mapping))

        unit = row["original_unit"]

        # Get example products for all units (both historical and new)
        example_products = _get_example_products(df, units_column, unit, product_name_column)
        unit_mapping.loc[idx, "example_products"] = example_products

        # Skip LLM processing if already classified historically
        if row["previously_classified"]:
            continue

        if pd.isna(unit):
            # If unit data is missing we can't extract anything so just set it all to na and
            # move on.
            unit_mapping.loc[idx, "llm_cleaned_unit"] = None
            unit_mapping.loc[idx, "llm_extracted_weight"] = None
        else:
            # If we have unit data, we can attempt to clean and extract weight and units
            # information.
            # Process cleaning and extraction separately so both pieces of information are captured
            try:
                cleaned_unit = clean_units_llm(unit, gemini_client=gemini_client)
            except Exception as e:
                print(f"Warning: Unit cleaning failed for '{unit}': {e}")
                cleaned_unit = "Unknown or unusable unit"

            try:
                extracted_weight = extract_weight_llm(
                    unit, gemini_client=gemini_client, custom_prompt=weight_extraction_instructions
                )
            except Exception as e:
                print(f"Warning: Weight extraction failed for '{unit}': {e}")
                extracted_weight = None

            unit_mapping.loc[idx, "llm_cleaned_unit"] = cleaned_unit
            unit_mapping.loc[idx, "llm_extracted_weight"] = extracted_weight

    # Post-processing: Replace "10 can" with "oz"
    mask_10can = unit_mapping["llm_cleaned_unit"].astype(str).str.upper().str.strip() == "10 CAN"
    if mask_10can.any():
        num_replaced = mask_10can.sum()
        print(f"\nReplacing {num_replaced} '10 can' classifications with 'oz'")
        unit_mapping.loc[mask_10can, "llm_cleaned_unit"] = "oz"

    # Fallback: Try to extract from product names when unit/weight extraction failed
    mask_needs_fallback = unit_mapping.apply(_is_extraction_failed, axis=1)

    if mask_needs_fallback.any():
        num_fallback = mask_needs_fallback.sum()
        print(f"\n{'=' * 60}")
        print("FALLBACK: Attempting product name extraction")
        print(f"{'=' * 60}")
        print(f"Trying to extract weight/units from product names for {num_fallback} failed units")

        fallback_rows = list(unit_mapping[mask_needs_fallback].iterrows())
        for count, (idx, row) in enumerate(fallback_rows, 1):
            # Print progress for fallback extraction
            print_progress("Extracting from product names", count, num_fallback)
            original_unit = row["original_unit"]

            # Get product names associated with this unit
            unit_rows = df[df[units_column] == original_unit]
            if unit_rows.empty or product_name_column not in df.columns:
                continue

            # Get a sample product name to try extraction from
            product_names = unit_rows[product_name_column].dropna().unique()
            if len(product_names) == 0:
                continue

            # Try the first product name (could be extended to try multiple)
            sample_product = product_names[0]

            # Attempt to extract from product name
            try:
                extracted_from_name = _extract_weight_unit_from_product_name(
                    sample_product, gemini_client, weight_extraction_instructions
                )

                # Only update if we got valid results and original was NaN/unknown
                if extracted_from_name["cleaned_unit"] and (
                    pd.isna(row["llm_cleaned_unit"])
                    or row["llm_cleaned_unit"] == "Unknown or unusable unit"
                ):
                    unit_mapping.loc[idx, "llm_cleaned_unit"] = extracted_from_name["cleaned_unit"]

                if extracted_from_name["extracted_weight"] is not None and pd.isna(
                    row["llm_extracted_weight"]
                ):
                    unit_mapping.loc[idx, "llm_extracted_weight"] = extracted_from_name[
                        "extracted_weight"
                    ]

                # Add note about fallback source
                if (
                    extracted_from_name["cleaned_unit"]
                    or extracted_from_name["extracted_weight"] is not None
                ):
                    current_examples = unit_mapping.loc[idx, "example_products"]
                    unit_mapping.loc[idx, "example_products"] = (
                        f"[FROM PRODUCT NAME: {sample_product}] "
                        f"{current_examples if current_examples else ''}"
                    )

            except Exception as e:
                # Log the error for debugging but continue processing other units
                logging.warning(
                    f"Fallback extraction failed for unit '{original_unit}' using "
                    f"product '{sample_product}': {e}"
                )
                continue

    return unit_mapping


# ----------------------------------------------------------------------
# Save unclear items to csv
# ----------------------------------------------------------------------


def create_unclear_items_csv(
    weights: pd.DataFrame, client_name: str, output_dir: str | None = None
) -> str:
    """
    Saves all items with unclear units or weights to a CSV file for manual review.

    Unclear items are those where:
      - 'llm_cleaned_unit' is missing or marked as "Unknown or unusable unit"
      - 'llm_extracted_weight' is missing

    Args:
        weights (pd.DataFrame): DataFrame containing unit classification results.
        client_name (str): Name of the client or dataset (used in filename).
        output_dir (Optional[str]): Directory to save the CSV file. If None, saves in current
            directory.

    Returns:
        str: The full path to the saved CSV file.

    Example:
        >>> create_unclear_items_csv(weights, "client")
        >>> create_unclear_items_csv(weights, "client", output_dir="results/")
    """
    # Validate input columns
    required_cols = ["llm_cleaned_unit", "llm_extracted_weight"]
    for col in required_cols:
        if col not in weights.columns:
            raise ValueError(f"Column '{col}' not found in DataFrame")

    unclear_items = weights[weights.apply(_is_extraction_failed, axis=1)]
    print(f"Found {len(unclear_items)} unclear items.")

    # Clean up client_name for filename
    filename = f"{client_name}_items_with_unclear_weights_units.csv"
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
        filepath = os.path.join(output_dir, filename)
    else:
        filepath = filename

    unclear_items.to_csv(filepath, index=False)

    return f"Saved unclear items to {filepath}"


# ----------------------------------------------------------------------
# Convert weights to kilograms
# ----------------------------------------------------------------------


def _compute_weight_in_kilograms(
    row: pd.Series,
    unit_column_name: str,
    weight_column_name: str,
    category_column_name: str,
    warnings_set: set[str],
) -> float:
    """
    Computes the weight in kilograms for a given row, based on the unit and product category.

    Args:
        row (pd.Series): A row of a DataFrame containing unit, weight, and category.
        unit_column_name (str): The name of the column containing unit identifiers.
        weight_column_name (str): The name of the column containing weight values.
        category_column_name (str): The name of the column containing product category labels.
        warnings_set (set): A set to collect unique warnings.

    Returns:
        float: The weight in kilograms, or np.nan if conversion is not possible.
    """
    unit = str(row[unit_column_name]).lower().strip()
    if not unit:
        warnings_set.add("Empty unit")
        return np.nan

    weight = row[weight_column_name]
    if not isinstance(weight, (int, float)) or weight <= 0:
        return np.nan

    category = str(row[category_column_name]).lower().strip()

    # Mapping of mass units to their conversion factors to kilograms
    mass_unit_to_kg_factor: dict[str, float] = {
        "lb": 0.453592,
        "lbs": 0.453592,
        "10 can": 0.453592,  # 10 cans are already converted to pounds
        "oz": 0.0283495,
        "g": 0.001,
        "gram": 0.001,
        "kg": 1,
    }

    # Mapping of volume units to their equivalent in liters
    volume_unit_to_liter_factor: dict[str, float] = {
        "gal": 3.78541,
        "qt": 0.946353,
        "gallon": 3.78541,
        "pt": 0.473176,
        "cup": 0.236588,
        "ml": 0.001,
        "l": 1,
        "fl oz": 0.0295735,
    }

    # Mapping of product categories to their densities in kg per liter
    product_category_to_density: dict[str, float] = {
        "liquid eggs": 1.04,
        "butter": 0.96,
        "ice cream": 0.74,
        "cream": 1.01,
        "milk (cow's milk)": 1.03,
        "yogurt": 1.04,
        "mayo": 0.93,
        "plant-based mayonaise": 0.93,
        "almond/coconut milk": 1.11,
        "oat milk": 1.11,
        "rice milk": 1.01,
        "soy milk": 1.03,
        "water-based": 1,  # Default density
    }

    # If the unit is a mass unit, apply the direct conversion factor
    if unit in mass_unit_to_kg_factor:
        return float(weight) * mass_unit_to_kg_factor[unit]

    # If the unit is a volume unit and the product category has a known density, compute weight
    if unit in volume_unit_to_liter_factor:
        volume_in_liters = float(weight) * volume_unit_to_liter_factor[unit]
        density = product_category_to_density.get(
            category, product_category_to_density["water-based"]
        )

        if category not in product_category_to_density:
            warnings_set.add(
                f"Category '{category}' not recognized for volume unit '{unit}', assuming "
                "water-based density."
            )

        return volume_in_liters * density

    # If the unit is 'dozen' and the category is 'shelled eggs', calculate weight
    if unit in ["dozen", "dz"] and category == "shelled eggs":
        return (
            float(weight) * 12 * 57 * 0.001
        )  # (number of dozens) * 12 eggs/dozen * 57 g/egg * 0.001 kg/g

    # Unrecognized unit
    warnings_set.add(f"Unit not recognized: {unit}")
    return np.nan


def convert_products_to_kilograms(
    df: pd.DataFrame, unit_column_name: str, weight_column_name: str, category_column_name: str
) -> pd.DataFrame:
    """
    Converts weights from various units to kilograms, considering both unit conversion factors
    and product-specific densities for volume-based units.

    Parameters:
        df (pd.DataFrame): The input DataFrame containing weight and unit information.
        unit_column_name (str): The name of the column containing unit identifiers (e.g., 'kg',
            'oz', 'cup').
        weight_column_name (str): The name of the column containing weight values.
        category_column_name (str): The name of the column containing product category labels.

    Returns:
        pd.DataFrame: The original DataFrame with an additional 'kilos' column representing
            weights in kilograms.
    """
    # Validate input columns
    for col in [unit_column_name, weight_column_name, category_column_name]:
        if col not in df.columns:
            raise ValueError(f"Column '{col}' not found in DataFrame")

    # Check for NaN values and warn user
    nan_counts = {
        col: df[col].isna().sum()
        for col in [unit_column_name, weight_column_name, category_column_name]
    }
    if any(count > 0 for count in nan_counts.values()):
        print("Warning: Found NaN values in the following columns:")
        for col, count in nan_counts.items():
            if count > 0:
                print(f"  - {col}: {count} NaN values")
        raise ValueError("Cannot convert products with NaN values. Please clean data first.")

    # Set to collect unique warnings
    warnings_set: set[str] = set()

    # Check for "10 can" once, more efficiently
    if df[unit_column_name].astype(str).str.lower().str.contains("10 can", na=False).any():
        warnings_set.add(
            "Warning: '10 can' found in units. Assuming ten cans have already been "
            "converted to pounds."
        )

    # Apply the conversion function to each row to compute the 'kilos_total' column
    df = df.copy()  # Avoid modifying the original DataFrame
    df["kilos_total"] = df.apply(
        lambda row: _compute_weight_in_kilograms(
            row, unit_column_name, weight_column_name, category_column_name, warnings_set
        ),
        axis=1,
    )

    # Print all unique warnings at the end
    if warnings_set:
        print("Conversion warnings:")
        for warning in sorted(warnings_set):
            print(f"  - {warning}")

    # Check for conversion failures
    failed_conversions = df["kilos_total"].isna().sum()
    if failed_conversions > 0:
        # Get the rows where 'kilos_total' is NaN
        failed_rows = df[df["kilos_total"].isna()]
        print(f"{failed_conversions} rows failed conversion:")
        print(failed_rows)

        # Raise the assertion error with the full failed rows
        raise AssertionError(
            f"{failed_conversions} rows failed conversion. See output above for details."
        )

    return df


# ----------------------------------------------------------------------
# Historical weight classification functions
# ----------------------------------------------------------------------


def classify_units_using_historical_weights(
    unit_mapping_df: pd.DataFrame,
) -> tuple[pd.DataFrame, dict[str, int | float]]:
    """
    Classifies unit strings using a historical list of weight classifications.

    This function loads previously classified weight units and merges the
    'llm_cleaned_unit' and 'llm_extracted_weight' from this historical data
    into the input `unit_mapping_df` based on matching 'original_unit' values.

    A 'previously_classified' boolean column is added to `unit_mapping_df`.
    This column is `True` if a unit was found in the historical data (and thus
    its weight classification columns are populated from historical data), and
    `False` otherwise.

    Args:
        unit_mapping_df (pd.DataFrame): DataFrame with an 'original_unit' column
                                        containing unique unit strings to classify.

    Returns:
        tuple: A tuple containing:
            - pd.DataFrame: The `unit_mapping_df` augmented with classification columns
            - Dict[str, Union[int, float]]: Statistics dictionary with keys:
                - 'total_units': Total number of units in input
                - 'matched_units': Number of units found in historical data
                - 'unmatched_units': Number of units not in historical data
                - 'match_percentage': Percentage of units matched
                - 'unmatch_percentage': Percentage of units not matched
    """
    # Validate input columns
    if "original_unit" not in unit_mapping_df.columns:
        raise ValueError("Column 'original_unit' not found in DataFrame")

    total_units = len(unit_mapping_df)

    previously_classified_weights = get_previously_classified_weights()

    # Select only the relevant columns for merging
    historical_weights = previously_classified_weights[
        ["original_unit", "llm_cleaned_unit", "llm_extracted_weight"]
    ].drop_duplicates()

    # Merge with historical data
    unit_mapping_df = unit_mapping_df.merge(
        historical_weights, on="original_unit", how="left", suffixes=("", "_historical")
    )

    # Determine which column has the historical data based on what existed in input
    # If input had llm_cleaned_unit, historical will be in llm_cleaned_unit_historical
    # If input didn't have it, historical will be in llm_cleaned_unit
    if "llm_cleaned_unit_historical" in unit_mapping_df.columns:
        historical_unit_col = "llm_cleaned_unit_historical"
    else:
        historical_unit_col = "llm_cleaned_unit"

    # If there are historical matches, use them; otherwise keep original values
    unit_mapping_df["previously_classified"] = unit_mapping_df[historical_unit_col].notna()

    # Calculate statistics
    matched_units = unit_mapping_df["previously_classified"].sum()
    unmatched_units = total_units - matched_units
    match_percentage = (matched_units / total_units * 100) if total_units > 0 else 0
    unmatch_percentage = (unmatched_units / total_units * 100) if total_units > 0 else 0

    overlap_stats = {
        "total_units": total_units,
        "matched_units": matched_units,
        "unmatched_units": unmatched_units,
        "match_percentage": match_percentage,
        "unmatch_percentage": unmatch_percentage,
    }

    # Fill in historical values where available
    if "llm_cleaned_unit_historical" in unit_mapping_df.columns:
        # Input had existing values, merge from _historical columns
        unit_mapping_df.loc[unit_mapping_df["previously_classified"], "llm_cleaned_unit"] = (
            unit_mapping_df.loc[
                unit_mapping_df["previously_classified"], "llm_cleaned_unit_historical"
            ]
        )
        unit_mapping_df.loc[unit_mapping_df["previously_classified"], "llm_extracted_weight"] = (
            unit_mapping_df.loc[
                unit_mapping_df["previously_classified"], "llm_extracted_weight_historical"
            ]
        )
    # else: values are already in llm_cleaned_unit and llm_extracted_weight columns from merge

    # Post-processing: Convert any legacy "10 can" entries to "oz" for consistency
    # This handles old historical data that was saved before the conversion logic was added
    mask_10can_historical = (
        unit_mapping_df["llm_cleaned_unit"].astype(str).str.upper().str.strip() == "10 CAN"
    )
    if mask_10can_historical.any():
        num_converted = mask_10can_historical.sum()
        print(
            f"  ⚠ Converting {num_converted} legacy '10 can' entries from historical data to 'oz'"
        )
        unit_mapping_df.loc[mask_10can_historical, "llm_cleaned_unit"] = "oz"

    # Clean up the temporary columns
    unit_mapping_df = unit_mapping_df.drop(
        columns=["llm_cleaned_unit_historical", "llm_extracted_weight_historical"], errors="ignore"
    )

    return unit_mapping_df, overlap_stats


def expand_historical_weight_classifications(df: pd.DataFrame) -> None:
    """
    Expands the historical weight classifications file with new data from a DataFrame.

    This function takes a DataFrame `df`, expected to contain weight
    classifications (at least 'original_unit', 'llm_cleaned_unit', and
    'llm_extracted_weight' columns). It loads the existing historical weight
    classifications, appends the relevant columns from the new `df`, and then
    de-duplicates based on the 'original_unit' column, keeping the last occurrence.
    This means entries from `df` will overwrite existing historical entries for
    the same original unit.

    The expanded and de-duplicated list is then saved back to the historical
    weight classifications CSV file, overwriting the original file.

    Args:
        df (pd.DataFrame): A DataFrame containing new or updated weight
                           classifications. It must include columns that are
                           present in the historical weight data file (e.g.,
                           'original_unit', 'llm_cleaned_unit', 'llm_extracted_weight',
                           'example_products').
    """
    # Validate input columns
    required_cols = ["original_unit", "llm_cleaned_unit", "llm_extracted_weight"]
    for col in required_cols:
        if col not in df.columns:
            raise ValueError(f"Column '{col}' not found in DataFrame")

    previously_classified_weights = get_previously_classified_weights()
    # Ensure df_filtered only contains columns that are also in previously_classified_weights
    # to prevent adding new, unexpected columns to the historical file.
    df_filtered = df[previously_classified_weights.columns.intersection(df.columns)]

    previously_classified_weights_expanded = pd.concat(
        [previously_classified_weights, df_filtered], ignore_index=True
    )
    previously_classified_weights_expanded = previously_classified_weights_expanded.drop_duplicates(
        subset=["original_unit"], keep="last"
    )
    print(
        "Unique weight units after expansion:",
        previously_classified_weights_expanded["original_unit"].nunique(),
    )
    previously_classified_weights_expanded.to_csv(
        get_previously_classified_weights_location(), index=False
    )


def get_previously_classified_weights_location() -> Path:
    """
    Returns the file path for the CSV containing previously classified weights.

    This function centralizes the logic for determining the location of the
    historical weight classifications file, which is located at
    "data_files/previously_classified_weights.csv" relative to this script's
    directory. Using a dedicated function ensures the path is consistent.

    Returns:
        Path: A pathlib.Path object representing the full path to the
              previously_classified_weights.csv file.
    """
    historical_weight_classifications_filepath = (
        PACKAGE_DIR / "data_files" / "previously_classified_weights.csv"
    )

    return historical_weight_classifications_filepath


def _empty_previously_classified_weights() -> pd.DataFrame:
    """Return an empty DataFrame with the previously-classified-weights schema."""
    return pd.DataFrame(
        columns=["original_unit", "llm_cleaned_unit", "llm_extracted_weight", "example_products"]
    )


def get_previously_classified_weights() -> pd.DataFrame:
    """
    Loads and returns the previously classified weights from the CSV file.

    This function reads the CSV file specified by
    `get_previously_classified_weights_location()` into a pandas DataFrame.
    It also prints a message indicating the number of weight units loaded from the file.

    Returns:
        pd.DataFrame: A DataFrame containing the historically classified weight units.
    """
    path = get_previously_classified_weights_location()
    if not path.exists():
        logger.warning(
            "Previously classified weights cache not found at %s (see data_files/README.md); "
            "every unit will go to the LLM.",
            path,
        )
        return _empty_previously_classified_weights()

    previously_classified_weights = pd.read_csv(path)

    print(
        "previously_classified_weights file has: "
        f"{previously_classified_weights.shape[0]} weight units in it"
    )
    return previously_classified_weights


def _extract_weight_unit_from_product_name(
    product_name: str, gemini_client: Any, custom_weight_prompt: str | None = None
) -> dict[str, str | None]:
    """
    Attempts to extract both weight and unit from a product name using LLM.

    Args:
        product_name (str): The product name to extract from.
        gemini_client (Any): The client for the Gemini API.
        custom_weight_prompt (Optional[str]): Custom instructions for weight extraction.

    Returns:
        Dict[str, Optional[str]]: Dictionary with keys 'cleaned_unit' and 'extracted_weight'.
                                  Values are None if extraction failed.
    """
    result = {"cleaned_unit": None, "extracted_weight": None}

    # Try to extract cleaned unit
    try:
        result["cleaned_unit"] = clean_units_llm(product_name, gemini_client=gemini_client)
        # If result is "Unknown or unusable unit", set to None
        if result["cleaned_unit"] == "Unknown or unusable unit":
            result["cleaned_unit"] = None
    except Exception as e:
        logging.debug(f"Failed to extract cleaned unit from product name '{product_name}': {e}")

    # Try to extract weight
    try:
        result["extracted_weight"] = extract_weight_llm(
            product_name, gemini_client=gemini_client, custom_prompt=custom_weight_prompt
        )
    except Exception as e:
        logging.debug(f"Failed to extract weight from product name '{product_name}': {e}")

    return result
