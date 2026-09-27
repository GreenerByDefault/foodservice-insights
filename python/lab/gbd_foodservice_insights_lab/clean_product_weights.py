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
    """Check if unit/weight extraction failed for a row of the unit_mapping DataFrame."""
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
    """Get up to `n` semicolon-separated example products for a filter value, or None if none."""
    filtered = df[df[filter_col] == filter_val]
    if filtered.empty or product_col not in df.columns:
        return None
    examples = filtered[product_col].dropna().unique()[:n]
    return "; ".join(examples) if len(examples) > 0 else None


def check_weight_unit_extraction(
    test_string: str, gemini_client: Any, weight_extraction_instructions: str | None = None
) -> dict[str, str | None]:
    """Check what the LLM extracts from one unit string, for manual debugging.

    For example, `check_weight_unit_extraction("16 oz bottle", client)` returns
    `{'input': '16 oz bottle', 'cleaned_unit': 'oz', 'extracted_weight': '16'}`.
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
    """Clean unit strings and extract weights using an LLM, returning a mapping table and stats.

    Each unique unit string is processed only once, and units already in the historical
    classifications skip the LLM. Where extraction from the unit string fails, it falls back to
    a product name from `product_name_column`. `units_column` holds strings like "16 oz",
    "1 lb 4 oz", or "500ml bottle". `weight_extraction_instructions` of None uses the default
    prompt from file.

    The returned DataFrame is a mapping table, not `df` with merged columns, sorted for review:
    `original_unit`, `llm_cleaned_unit` (e.g. "oz", "lb", "ml"), `llm_extracted_weight`,
    `example_products` (up to 5), and `previously_classified`. The stats dict has `total_units`,
    `nan_units`, `unknown_units` ("Unknown or unusable"), `nan_weights`, `previously_classified`,
    and `success_rate` (a percentage).

    Typical workflow:
        >>> weights, stats = extract_weight_units_pipeline(df, "pack_size", client)
        >>> # Optionally save to CSV, hand-fix errors, and reload.
        >>> df = df.merge(weights, left_on="pack_size", right_on="original_unit")
        >>> expand_historical_weight_classifications(weights)  # Reuse on future runs.
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
    """Gets the unique units from the DataFrame."""
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
    """Builds a mapping from original units to cleaned units and extracted weights using an LLM.

    `df` is the original DataFrame, sampled for product names. The result has columns
    'original_unit', 'llm_cleaned_unit', 'llm_extracted_weight', and 'example_products'.
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
    """Saves all items with unclear units or weights to a CSV file for manual review.

    Unclear items are those where 'llm_cleaned_unit' is missing or "Unknown or unusable unit",
    or 'llm_extracted_weight' is missing. `client_name` goes in the filename; `output_dir` of
    None saves in the current directory.
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
    """Computes the weight in kilograms for a given row, based on the unit and product category.

    Returns np.nan if conversion is not possible; unique warnings are added to `warnings_set`.
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
    """Converts weights to kilograms, using product-category densities for volume units.

    Units look like 'kg', 'oz', or 'cup'. Returns `df` with an added 'kilos' column.
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
    """Classifies unit strings using a historical list of weight classifications.

    Merges 'llm_cleaned_unit' and 'llm_extracted_weight' from the historical data into
    `unit_mapping_df` by 'original_unit', and adds a 'previously_classified' column that is True
    where the unit was found. The stats dict has 'total_units', 'matched_units',
    'unmatched_units', 'match_percentage', and 'unmatch_percentage'.
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
    """Expands the historical weight classifications file with new data from a DataFrame.

    `df` needs 'original_unit', 'llm_cleaned_unit', and 'llm_extracted_weight'; only its columns
    that the historical file already has are kept. Rows are de-duplicated on 'original_unit',
    so entries from `df` overwrite historical ones, and the CSV is overwritten in place.
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
    """Returns the path of data_files/previously_classified_weights.csv in this package."""
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
    """Loads and returns the previously classified weights from the CSV file."""
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
    """Attempts to extract both weight and unit from a product name using LLM.

    Values are None where extraction failed.
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
