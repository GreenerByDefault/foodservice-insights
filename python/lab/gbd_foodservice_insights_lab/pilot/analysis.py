from __future__ import annotations

import pandas as pd
from gbd_foodservice_insights.categories import (
    get_animal_product_categories,
    get_dairy_categories,
    get_drink_categories,
    get_egg_categories,
    get_food_categories,
    get_GBD_categories,
    get_meat_categories,
    get_plant_based_categories,
    get_plant_protein_categories,
    get_protein_categories,
)


def _load_and_concat_data(
    baseline_input_file: str,
    pilot_input_file: str,
    sheet_name: str,
    transpose: bool = False,
    drop_total_column: bool = False,
    drop_total_row: bool = False,
    merge_on_category: bool = False,
    validate_months: bool = False,
) -> pd.DataFrame:
    """
    Generic helper function to load and combine data from baseline and pilot Excel files.

    Args:
        baseline_input_file (str): Path to baseline Excel file.
        pilot_input_file (str): Path to pilot Excel file.
        sheet_name (str): Name of the sheet to load.
        transpose (bool): Whether to transpose the data. Defaults to False.
        drop_total_column (bool): Whether to drop 'total' column. Defaults to False.
        drop_total_row (bool): Whether to drop rows where a column equals 'total'.
            Defaults to False.
        merge_on_category (bool): Whether to merge (inner join on 'category') instead of
            concat. Defaults to False.
        validate_months (bool): Whether to validate that baseline and pilot have same number
            of months. Defaults to False.

    Returns:
        pd.DataFrame: Combined or merged data.
    """
    baseline_data = pd.read_excel(baseline_input_file, sheet_name=sheet_name)
    pilot_data = pd.read_excel(pilot_input_file, sheet_name=sheet_name)

    if transpose:
        baseline_data = baseline_data.T.reset_index()
        pilot_data = pilot_data.T.reset_index()

    if drop_total_column:
        baseline_data.drop(columns=["total"], inplace=True)
        pilot_data.drop(columns=["total"], inplace=True)

    if merge_on_category:
        return pd.merge(baseline_data, pilot_data, on="category", how="inner")

    baseline_data["period"] = "baseline"
    pilot_data["period"] = "pilot"
    combined_data = pd.concat([baseline_data, pilot_data], ignore_index=True)

    if drop_total_row:
        # Assumes transposed data with 'index' and 0 columns need renaming
        combined_data.rename(columns={"index": "month_year", 0: "diner-meals"}, inplace=True)
        combined_data = combined_data.loc[combined_data["month_year"] != "total", :]

    if validate_months:
        baseline_months = combined_data.loc[
            combined_data["period"] == "baseline", "month_year"
        ].nunique()
        pilot_months = combined_data.loc[combined_data["period"] == "pilot", "month_year"].nunique()
        assert baseline_months == pilot_months, (
            "Baseline and Pilot must have the same number of unique months "
            f"(baseline={baseline_months}, pilot={pilot_months}). Proceed with caution."
        )

    return combined_data


def load_template_data(baseline_input_file: str, pilot_input_file: str) -> pd.DataFrame:
    """
    Load and merge template data from baseline and pilot Excel files.

    Args:
        baseline_input_file (str): Path to baseline Excel file with "Template Data" sheet.
        pilot_input_file (str): Path to pilot Excel file with "Template Data" sheet.

    Returns:
        pd.DataFrame: Merged template data with columns from both baseline and pilot periods.
    """
    return _load_and_concat_data(
        baseline_input_file,
        pilot_input_file,
        sheet_name="Template Data",
        drop_total_column=True,
        merge_on_category=True,
    )


def load_monthly_product_data(baseline_input_file: str, pilot_input_file: str) -> pd.DataFrame:
    """
    Load and combine monthly product data from baseline and pilot Excel files.

    Args:
        baseline_input_file (str): Path to baseline Excel file with "Monthly Product Data" sheet.
        pilot_input_file (str): Path to pilot Excel file with "Monthly Product Data" sheet.

    Returns:
        pd.DataFrame: Combined monthly product data with 'period' column indicating baseline
            or pilot.
    """
    return _load_and_concat_data(
        baseline_input_file, pilot_input_file, sheet_name="Monthly Product Data"
    )


def load_monthly_category_data(baseline_input_file: str, pilot_input_file: str) -> pd.DataFrame:
    """
    Load and combine monthly category data from baseline and pilot Excel files.

    Args:
        baseline_input_file (str): Path to baseline Excel file with "Monthly Category Data" sheet.
        pilot_input_file (str): Path to pilot Excel file with "Monthly Category Data" sheet.

    Returns:
        pd.DataFrame: Combined monthly category data with 'period' column indicating baseline
            or pilot.
    """
    return _load_and_concat_data(
        baseline_input_file, pilot_input_file, sheet_name="Monthly Category Data"
    )


def load_diner_meal_data(
    baseline_input_file: str, pilot_input_file: str, validate_months: bool = True
) -> pd.DataFrame:
    """
    Load and combine diner-meal numbers from baseline and pilot Excel files.

    Args:
        baseline_input_file (str): Path to baseline Excel file with "Diner-Meal Numbers" sheet.
        pilot_input_file (str): Path to pilot Excel file with "Diner-Meal Numbers" sheet.
        validate_months (bool, optional): Whether to validate that baseline and pilot have the same
                                         number of months. Defaults to True.

    Returns:
        pd.DataFrame: Combined diner-meal data with columns 'month_year', 'diner-meals', and
            'period'.
                     The 'total' row is removed as it's not needed for analysis.
    """
    return _load_and_concat_data(
        baseline_input_file,
        pilot_input_file,
        sheet_name="Diner-Meal Numbers",
        transpose=True,
        drop_total_row=True,
        validate_months=validate_months,
    )


def load_monthly_product_category_data(
    baseline_input_file: str, pilot_input_file: str
) -> pd.DataFrame:
    """
    Load and combine monthly product x category data from baseline and pilot Excel files.

    Args:
        baseline_input_file (str): Path to baseline Excel file with "Monthly Product x
            category Data" sheet.
        pilot_input_file (str): Path to pilot Excel file with "Monthly Product x category
            Data" sheet.

    Returns:
        pd.DataFrame: Combined monthly product x category data with 'period' column
            indicating baseline or pilot.
    """
    return _load_and_concat_data(
        baseline_input_file, pilot_input_file, sheet_name="Monthly Product x category Data"
    )


def load_all_pilot_data(
    baseline_input_file: str,
    pilot_input_file: str,
    include_total_meat: bool = True,
    validate_months: bool = True,
) -> dict:
    """
    Load all pilot analysis datasets in one call.

    This function loads all datasets needed for pilot analysis:
    - template_data: Merged template data from baseline and pilot
    - monthly_product_data: Combined monthly product data
    - monthly_category_data: Combined monthly category data
    - diner_meal_data: Combined diner-meal numbers
    - monthly_product_category_data: Combined monthly product x category data
    - period_category_data: Aggregated period-level category data with kilos per diner-meal

    Args:
        baseline_input_file (str): Path to baseline Excel file.
        pilot_input_file (str): Path to pilot Excel file.
        include_total_meat (bool, optional): Whether to include aggregate "total meat" category
                                            in period_category_data. Defaults to True.
        validate_months (bool, optional): Whether to validate that baseline and pilot have the same
                                         number of months. Defaults to True.

    Returns:
        dict: Dictionary with keys:
            - 'template_data': pd.DataFrame
            - 'monthly_product_data': pd.DataFrame
            - 'monthly_category_data': pd.DataFrame
            - 'diner_meal_data': pd.DataFrame
            - 'monthly_product_category_data': pd.DataFrame
            - 'period_category_data': pd.DataFrame
    """
    template_data = load_template_data(baseline_input_file, pilot_input_file)
    monthly_product_data = load_monthly_product_data(baseline_input_file, pilot_input_file)
    monthly_category_data = load_monthly_category_data(baseline_input_file, pilot_input_file)
    diner_meal_data = load_diner_meal_data(
        baseline_input_file, pilot_input_file, validate_months=validate_months
    )
    monthly_product_category_data = load_monthly_product_category_data(
        baseline_input_file, pilot_input_file
    )
    period_category_data = create_period_category_data(
        monthly_category_data=monthly_category_data,
        diner_meal_data=diner_meal_data,
        include_total_meat=include_total_meat,
    )

    return {
        "template_data": template_data,
        "monthly_product_data": monthly_product_data,
        "monthly_category_data": monthly_category_data,
        "diner_meal_data": diner_meal_data,
        "monthly_product_category_data": monthly_product_category_data,
        "period_category_data": period_category_data,
    }


def calculate_product_overlap(monthly_product_data: pd.DataFrame) -> dict:
    """
    Calculate the overlap of unique product names between baseline and pilot periods.

    This function normalizes product names (lowercase, strip whitespace) to determine
    how many products are consistent between baseline and pilot periods. This helps
    assess whether changes in metrics are due to menu composition shifts vs actual
    intervention effects.

    Args:
        monthly_product_data (pd.DataFrame): DataFrame with 'product_name' and 'period' columns.

    Returns:
        dict: Dictionary with keys:
            - 'baseline_unique': int - Number of unique products in baseline
            - 'pilot_unique': int - Number of unique products in pilot
            - 'overlap_count': int - Number of products appearing in both periods
            - 'overlap_percentage': float - Percentage of baseline products appearing in pilot
    """
    # Normalize product names: lowercase and strip whitespace
    monthly_product_data = monthly_product_data.copy()
    monthly_product_data["normalized_name"] = (
        monthly_product_data["product_name"].str.lower().str.strip()
    )

    # Get unique normalized names for each period
    baseline_products = set(
        monthly_product_data[monthly_product_data["period"] == "baseline"][
            "normalized_name"
        ].unique()
    )
    pilot_products = set(
        monthly_product_data[monthly_product_data["period"] == "pilot"]["normalized_name"].unique()
    )

    # Calculate overlap
    overlap = baseline_products.intersection(pilot_products)
    overlap_percentage = (
        (len(overlap) / len(baseline_products) * 100) if len(baseline_products) > 0 else 0
    )

    return {
        "baseline_unique": len(baseline_products),
        "pilot_unique": len(pilot_products),
        "overlap_count": len(overlap),
        "overlap_percentage": overlap_percentage,
    }


def plant_animal_split(monthly_category_data: pd.DataFrame) -> pd.Series:
    """
    Calculate the percentage of plant-based protein vs animal protein for each period.

    Args:
        monthly_category_data (pd.DataFrame): DataFrame with columns ['category', 'period',
            'kilos_total']. Categories should match GBD categories from YAML.

    Returns:
        pd.Series: Series with period as index and plant-based protein percentage as values.

    Raises:
        ValueError: If the data contains categories not defined in the GBD categories YAML.
    """
    # Get valid protein and animal categories from YAML (lowercase for comparison)
    valid_gbd_categories = set(get_GBD_categories(lowercase=True))
    protein_categories = set(get_protein_categories(lowercase=True))
    animal_proteins = set(get_animal_product_categories(lowercase=True))

    # Validate that all categories in the data are valid GBD categories
    data_categories = set(monthly_category_data["category"].str.lower().unique())
    invalid_categories = data_categories - valid_gbd_categories

    if invalid_categories:
        raise ValueError(
            "The following categories in the data are not defined in "
            f"GBD_categories.yaml: {invalid_categories}"
        )

    # Filter data for protein categories only
    protein_data = monthly_category_data[
        monthly_category_data["category"].str.lower().isin(protein_categories)
    ].copy()

    # Add animal/plant classification based on YAML data
    protein_data["protein_type"] = (
        protein_data["category"]
        .str.lower()
        .apply(lambda x: "animal" if x in animal_proteins else "plant")
    )

    # Sum total kilos by protein type and period
    protein_totals = (
        protein_data.groupby(["protein_type", "period"])["kilos_total"].sum().reset_index()
    )

    # Calculate total protein for each period
    period_totals = protein_totals.groupby("period")["kilos_total"].sum().reset_index()
    period_totals.rename(columns={"kilos_total": "total_protein"}, inplace=True)

    # Merge and calculate percentages
    protein_summary = protein_totals.merge(period_totals, on="period")
    protein_summary["percentage"] = (
        protein_summary["kilos_total"] / protein_summary["total_protein"] * 100
    ).round(1)

    # Get plant-based percentages
    plant_percentages = protein_summary[protein_summary["protein_type"] == "plant"][
        ["period", "percentage"]
    ]
    plant_percentages = plant_percentages.set_index("period")["percentage"]

    return plant_percentages


def compare_plant_based_product_counts(monthly_product_category_data: pd.DataFrame) -> pd.DataFrame:
    """
    Compare the number of unique plant-based products between baseline and pilot periods.

    This function filters the data to only include plant-based categories (as defined in
    GBD_categories.yaml), then counts the number of unique products in each category for
    both baseline and pilot periods. It also provides a fuller breakdown showing which
    products were added or removed within each plant-based category, so the notebook can
    explain not just whether counts changed but how the mix changed.

    Args:
        monthly_product_category_data (pd.DataFrame): DataFrame with columns
            ['product', 'category', 'period']. The 'period' column should contain
            'baseline' and 'pilot' values.

    Returns:
        pd.DataFrame: DataFrame with columns:
            - meta_category (str): Always "Plant-Based"
            - category (str): The plant-based category name
            - baseline_count (int): Number of unique products in baseline period
            - pilot_count (int): Number of unique products in pilot period
            - change (int): Difference in unique product count (pilot - baseline)
            - pct_change (float): Percentage change from baseline to pilot
            - retained_count (int): Number of unique products appearing in both periods
            - products_added_count (int): Number of products newly appearing in pilot
            - products_removed_count (int): Number of products present in baseline but not pilot
            - increased (bool): True if pilot_count > baseline_count
            - baseline_products (list[str]): Unique baseline product names in this category
            - pilot_products (list[str]): Unique pilot product names in this category
            - products_added (list[str]): Products newly appearing in pilot
            - products_removed (list[str]): Products no longer appearing in pilot
        Sorted by absolute change (descending).

    Example:
        >>> result = compare_plant_based_product_counts(monthly_product_category_data)
        >>> print_plant_based_product_changes(result)
    """
    required_columns = {"product", "category", "period"}
    missing = required_columns - set(monthly_product_category_data.columns)
    if missing:
        raise ValueError(f"monthly_product_category_data is missing required columns: {missing}")

    data = monthly_product_category_data.copy()

    # Get canonical plant-based categories from YAML so we can return a complete
    # category-by-category breakdown for the full plant-based meta category.
    plant_based_categories = get_plant_based_categories(lowercase=False)
    plant_based_lookup = {category.lower(): category for category in plant_based_categories}

    # Normalize categories and product names so harmless casing/spacing differences
    # do not create fake product-count changes between baseline and pilot.
    data["category_lower"] = data["category"].astype(str).str.strip().str.lower()
    data["product_clean"] = data["product"].astype(str).str.strip()
    data["normalized_product"] = data["product_clean"].str.lower()

    # Filter to only plant-based categories from the YAML source of truth.
    data = data[data["category_lower"].isin(plant_based_lookup)].copy()

    if data.empty:
        print("Warning: No plant-based categories found in the data.")
        return pd.DataFrame(
            {
                "meta_category": ["Plant-Based"] * len(plant_based_categories),
                "category": plant_based_categories,
                "baseline_count": [0] * len(plant_based_categories),
                "pilot_count": [0] * len(plant_based_categories),
                "change": [0] * len(plant_based_categories),
                "pct_change": [0.0] * len(plant_based_categories),
                "retained_count": [0] * len(plant_based_categories),
                "products_added_count": [0] * len(plant_based_categories),
                "products_removed_count": [0] * len(plant_based_categories),
                "increased": [False] * len(plant_based_categories),
                "baseline_products": [[] for _ in plant_based_categories],
                "pilot_products": [[] for _ in plant_based_categories],
                "products_added": [[] for _ in plant_based_categories],
                "products_removed": [[] for _ in plant_based_categories],
            }
        )

    product_lookup = (
        data.loc[
            data["product_clean"].ne(""),
            ["category_lower", "period", "normalized_product", "product_clean"],
        ]
        .sort_values("product_clean")
        .drop_duplicates(["category_lower", "period", "normalized_product"])
    )

    period_product_maps = {}
    for (category_lower, period), group in product_lookup.groupby(
        ["category_lower", "period"], sort=False
    ):
        period_product_maps[(category_lower, period)] = dict(
            zip(group["normalized_product"], group["product_clean"], strict=True)
        )

    rows = []
    for category_lower, category in plant_based_lookup.items():
        baseline_map = period_product_maps.get((category_lower, "baseline"), {})
        pilot_map = period_product_maps.get((category_lower, "pilot"), {})

        baseline_keys = set(baseline_map.keys())
        pilot_keys = set(pilot_map.keys())
        retained_keys = baseline_keys & pilot_keys
        added_keys = pilot_keys - baseline_keys
        removed_keys = baseline_keys - pilot_keys

        baseline_products = [
            baseline_map[key]
            for key in sorted(baseline_keys, key=lambda item: baseline_map[item].lower())
        ]
        pilot_products = [
            pilot_map[key] for key in sorted(pilot_keys, key=lambda item: pilot_map[item].lower())
        ]
        products_added = [
            pilot_map[key] for key in sorted(added_keys, key=lambda item: pilot_map[item].lower())
        ]
        products_removed = [
            baseline_map[key]
            for key in sorted(removed_keys, key=lambda item: baseline_map[item].lower())
        ]

        baseline_count = len(baseline_keys)
        pilot_count = len(pilot_keys)
        change = pilot_count - baseline_count

        if baseline_count == 0:
            pct_change = 0.0 if pilot_count == 0 else None
        else:
            pct_change = round(change / baseline_count * 100, 1)

        rows.append(
            {
                "meta_category": "Plant-Based",
                "category": category,
                "baseline_count": baseline_count,
                "pilot_count": pilot_count,
                "change": change,
                "pct_change": pct_change,
                "retained_count": len(retained_keys),
                "products_added_count": len(added_keys),
                "products_removed_count": len(removed_keys),
                "increased": change > 0,
                "baseline_products": baseline_products,
                "pilot_products": pilot_products,
                "products_added": products_added,
                "products_removed": products_removed,
            }
        )

    result = pd.DataFrame(rows)

    # Sort by absolute change (largest changes first)
    result = result.sort_values(
        by=["change", "products_added_count", "products_removed_count", "category"],
        key=lambda column: column.abs() if column.name == "change" else column,
        ascending=[False, False, False, True],
    )

    return result


def analyze_category_consumption(
    period_category_data: pd.DataFrame,
    diner_meal_data: pd.DataFrame,
    categories: list[str] | None = None,
    category_label: str = "Category",
) -> tuple[pd.Series, pd.DataFrame, pd.DataFrame]:
    """
    Analyze consumption for any combination of categories, comparing baseline and pilot periods.

    Args:
        period_category_data (pd.DataFrame): DataFrame with columns ['category', 'period',
            'kilos_total'].
        diner_meal_data (pd.DataFrame): DataFrame with columns ['period', 'diner-meals'].
        categories (list[str] | None): List of category names to include in the analysis.
                                       If None, will auto-detect based on category_label.
        category_label (str): Label to use in outputs (e.g., "Meat", "Dairy", "Animal
            Products", "Eggs"). If categories is None, this will be used to auto-fetch the
            appropriate categories. Defaults to "Category".

    Returns:
        tuple[pd.Series, pd.DataFrame, pd.DataFrame]:
            - per_diner_meal: Series with 'baseline' and 'pilot' consumption per diner-meal (kg)
            - summary: DataFrame with detailed breakdown including total, diner-meals, and
              per-diner-meal metrics
            - averted_summary: DataFrame with expected consumption, actual consumption, and
              averted metrics
    """
    # Auto-resolve categories based on category_label if not provided
    if categories is None:
        category_label_lower = category_label.lower()
        category_getters = {
            "meat": get_meat_categories,
            "dairy": get_dairy_categories,
            "animal products": get_animal_product_categories,
            "eggs": get_egg_categories,
            "plant protein": get_plant_protein_categories,
            "protein": get_protein_categories,
            "food": get_food_categories,
            "drink": get_drink_categories,
        }

        if category_label_lower in category_getters:
            categories = category_getters[category_label_lower](lowercase=True)
        else:
            raise ValueError(
                f"Cannot auto-resolve categories for label '{category_label}'. Please "
                f"provide categories explicitly or use one of: {list(category_getters.keys())}"
            )

    # Filter period_category_data for specified categories only
    category_period_data = period_category_data.loc[
        period_category_data["category"].isin(categories), :
    ]

    # Check if we have any data for these categories
    if category_period_data.empty:
        raise ValueError(f"No data found for categories: {categories}")

    total_by_period = category_period_data.groupby("period")["kilos_total"].sum()
    total_diner_meals_by_period = diner_meal_data.groupby("period")["diner-meals"].sum()

    # Make sure both baseline and pilot periods exist
    for period in ["baseline", "pilot"]:
        if period not in total_by_period.index:
            total_by_period[period] = 0.0

    per_diner_meal = total_by_period / total_diner_meals_by_period

    # Create summary DataFrame
    summary = pd.DataFrame(
        {
            "Period": ["Baseline", "Pilot"],
            f"Total {category_label} (kg)": [total_by_period["baseline"], total_by_period["pilot"]],
            "Total Diner-Meals": [
                total_diner_meals_by_period["baseline"],
                total_diner_meals_by_period["pilot"],
            ],
            f"{category_label} per Diner-Meal (kg)": [
                per_diner_meal["baseline"],
                per_diner_meal["pilot"],
            ],
        }
    )

    # Calculate absolute and percentage change
    absolute_change = per_diner_meal["pilot"] - per_diner_meal["baseline"]
    percent_change = (
        (per_diner_meal["pilot"] - per_diner_meal["baseline"]) / per_diner_meal["baseline"] * 100
    )

    print(f"=== {category_label.upper()} CONSUMPTION ANALYSIS ===")
    print(
        f"\nBaseline {category_label.lower()} per diner-meal: {per_diner_meal['baseline']:.3f} kg"
    )
    print(f"Pilot {category_label.lower()} per diner-meal: {per_diner_meal['pilot']:.3f} kg")
    print(f"\nAbsolute change: {absolute_change:.3f} kg")
    print(f"Percentage change: {percent_change:.2f}%")

    print("\nDetailed breakdown:")
    print(summary.round(3))

    # Calculate consumption averted
    baseline_per_diner_meal = per_diner_meal["baseline"]
    pilot_diner_meals = total_diner_meals_by_period["pilot"]
    actual_pilot = per_diner_meal["pilot"] * pilot_diner_meals
    expected_pilot = baseline_per_diner_meal * pilot_diner_meals
    averted = expected_pilot - actual_pilot
    averted_tonnes = averted / 1000

    # Calculate servings averted (4oz = 113.4 grams per serving)
    oz_to_kg = 0.0283495  # 1 oz = 0.0283495 kg
    serving_size_kg = 4 * oz_to_kg  # 4 oz in kg
    servings_averted = averted / serving_size_kg

    print(f"\n=== TOTAL AMOUNT OF {category_label.upper()} AVERTED ===")
    print(
        f"\nBaseline {category_label.lower()} consumption rate: "
        f"{baseline_per_diner_meal:.3f} kg per diner-meal"
    )
    print(f"Number of people/meals served during pilot: {pilot_diner_meals:,} diner-meals")
    print(
        f"Expected {category_label.lower()} consumption (if baseline rates continued): "
        f"{expected_pilot:.1f} kg"
    )
    print(f"Actual {category_label.lower()} consumption during pilot: {actual_pilot:.1f} kg")
    print(
        f"\nTotal {category_label.lower()} averted: {averted:.1f} kg,  {averted_tonnes:.2f} tonnes"
    )
    print(
        f"Servings of {category_label.lower()} averted (4oz per serving): "
        f"{servings_averted:,.0f} servings"
    )

    # Create averted summary table
    averted_summary = pd.DataFrame(
        {
            "Metric": [
                f"Expected {category_label.lower()} consumption (kg)",
                f"Actual {category_label.lower()} consumption (kg)",
                f"{category_label} averted (kg)",
                f"{category_label} averted (tonnes)",
                "Servings averted (4oz/serving)",
            ],
            "Value": [
                f"{expected_pilot:.1f}",
                f"{actual_pilot:.1f}",
                f"{averted:.1f}",
                f"{averted_tonnes:.2f}",
                f"{servings_averted:,.0f}",
            ],
        }
    )

    return per_diner_meal, summary, averted_summary


def analyze_meat_consumption(
    period_category_data: pd.DataFrame, diner_meal_data: pd.DataFrame
) -> tuple[pd.Series, pd.DataFrame, pd.DataFrame]:
    """
    Analyze meat consumption comparing baseline and pilot periods, including meat averted
    calculation.

    Args:
        period_category_data (pd.DataFrame): DataFrame with columns ['category', 'period',
            'kilos_total']. Must contain meat category data for both baseline and pilot
            periods.
        diner_meal_data (pd.DataFrame): DataFrame with columns ['period', 'diner-meals'].

    Returns:
        tuple[pd.Series, pd.DataFrame, pd.DataFrame]:
            - meat_per_diner_meal: Series with 'baseline' and 'pilot' meat consumption per
              diner-meal (kg)
            - meat_summary: DataFrame with detailed breakdown including total meat,
              diner-meals, and per-diner-meal metrics
            - averted_summary: DataFrame with expected meat consumption, actual consumption,
              and meat averted metrics
    """
    return analyze_category_consumption(
        period_category_data=period_category_data,
        diner_meal_data=diner_meal_data,
        category_label="Meat",
    )


def analyze_animal_product_consumption(
    period_category_data: pd.DataFrame, diner_meal_data: pd.DataFrame
) -> tuple[pd.Series, pd.DataFrame, pd.DataFrame]:
    """
    Analyze animal product consumption (meat, dairy, eggs) comparing baseline and pilot periods.

    Args:
        period_category_data (pd.DataFrame): DataFrame with columns ['category', 'period',
            'kilos_total'].
        diner_meal_data (pd.DataFrame): DataFrame with columns ['period', 'diner-meals'].

    Returns:
        tuple[pd.Series, pd.DataFrame, pd.DataFrame]:
            - animal_product_per_diner_meal: Series with 'baseline' and 'pilot' consumption
              per diner-meal (kg)
            - animal_product_summary: DataFrame with detailed breakdown
            - averted_summary: DataFrame with expected consumption, actual consumption, and
              averted metrics
    """
    return analyze_category_consumption(
        period_category_data=period_category_data,
        diner_meal_data=diner_meal_data,
        category_label="Animal Products",
    )


def analyze_milk_consumption(
    period_category_data: pd.DataFrame, diner_meal_data: pd.DataFrame
) -> tuple[pd.Series, pd.DataFrame, pd.DataFrame]:
    """
    Analyze milk consumption comparing baseline and pilot periods.

    Args:
        period_category_data (pd.DataFrame): DataFrame with columns ['category', 'period',
            'kilos_total'].
        diner_meal_data (pd.DataFrame): DataFrame with columns ['period', 'diner-meals'].

    Returns:
        tuple[pd.Series, pd.DataFrame, pd.DataFrame]:
            - milk_per_diner_meal: Series with 'baseline' and 'pilot' milk consumption per
              diner-meal (kg)
            - milk_summary: DataFrame with detailed breakdown
            - averted_summary: DataFrame with expected consumption, actual consumption, and
              averted metrics
    """
    # Use the generalized function with just the "Milk (cow's milk)" category
    # This is the standard category name in GBD_categories.yaml
    return analyze_category_consumption(
        period_category_data=period_category_data,
        diner_meal_data=diner_meal_data,
        categories=["milk (cow's milk)"],  # full category name from YAML
        category_label="Milk",
    )


def calculate_meat_averted(
    meat_per_diner_meal: pd.Series, diner_meal_data: pd.DataFrame
) -> pd.DataFrame:
    """
    This function has been removed and merged into analyze_meat_consumption().

    Migration Instructions:
    -----------------------
    OLD CODE:
        meat_per_diner_meal, meat_summary = analyze_meat_consumption(
            period_category_data, diner_meal_data
        )
        averted_summary = calculate_meat_averted(meat_per_diner_meal, diner_meal_data)

    NEW CODE:
        meat_per_diner_meal, meat_summary, averted_summary = analyze_meat_consumption(
            period_category_data, diner_meal_data
        )
    The analyze_meat_consumption() function now returns three values instead of two:
        1. meat_per_diner_meal (pd.Series): Baseline and pilot meat consumption per diner-meal
        2. meat_summary (pd.DataFrame): Detailed breakdown by period
        3. averted_summary (pd.DataFrame): Meat averted calculations
    """
    raise NotImplementedError(
        "calculate_meat_averted() has been removed. Use analyze_meat_consumption("
        "period_category_data, diner_meal_data) instead, which now returns "
        "(meat_per_diner_meal, meat_summary, averted_summary). See function docstring for "
        "migration instructions."
    )


def create_period_category_data(
    monthly_category_data: pd.DataFrame,
    diner_meal_data: pd.DataFrame,
    include_total_meat: bool = True,
) -> pd.DataFrame:
    """
    Create period-level category data with kilos per diner_meal calculations.

    This function aggregates monthly category data by period, optionally adds a
    "total meat" aggregate category, and calculates kilos per diner_meal metrics.

    Args:
        monthly_category_data (pd.DataFrame): DataFrame with columns ['category', 'period',
            'kilos_total'].
        diner_meal_data (pd.DataFrame): DataFrame with columns ['period', 'diner-meals'].
        include_total_meat (bool, optional): Whether to add an aggregate "total meat" category
                                            combining beef, pork, and poultry. Defaults to True.

    Returns:
        pd.DataFrame: DataFrame with columns ['category', 'period', 'kilos_total',
            'diner-meals', 'kilos per diner-meal'].
    """
    # Aggregate by category and period
    period_category_data = (
        monthly_category_data.groupby(["category", "period"], as_index=False)["kilos_total"]
        .sum()
        .round(1)
    )

    if include_total_meat:
        # Define meat categories and calculate totals
        meat_categories = ["beef and buffalo meat", "pork (pig meat)", "poultry (chicken & turkey)"]
        meat_totals = (
            period_category_data.loc[period_category_data["category"].isin(meat_categories)]
            .groupby("period")[["kilos_total"]]
            .sum()
            .reset_index()
        )

        meat_totals["category"] = "total meat (beef, pork, poultry)"

        # Add total meat row to the data
        period_category_data = pd.concat([period_category_data, meat_totals], ignore_index=True)

    # Add diner-meal data and calculate per-diner-meal metrics
    diner_meals_period = diner_meal_data.groupby("period")["diner-meals"].sum().reset_index()
    period_category_data = period_category_data.merge(diner_meals_period, on="period", how="left")
    period_category_data["kilos per diner-meal"] = (
        period_category_data["kilos_total"] / period_category_data["diner-meals"]
    )

    return period_category_data


def get_category_baseline_pilot_comparison(
    period_category_data: pd.DataFrame, metric: str = "kilos per diner-meal"
) -> pd.DataFrame:
    """
    Create a summary table comparing baseline and pilot values for each category,
    with absolute, percentage, and multiplicative change calculations.

    Args:
        period_category_data (pd.DataFrame): DataFrame with columns ['category', 'period',
            metric]. Must contain both 'baseline' and 'pilot' values for each category.
        metric (str, optional): The column name to pivot on. Defaults to "kilos per diner-meal".

    Returns:
        pd.DataFrame: Pivoted DataFrame with columns:
            - 'category': GBD category name
            - 'baseline': baseline period values
            - 'pilot': pilot period values
            - 'change': absolute change (pilot - baseline)
            - 'pct_change': percentage change from baseline to pilot
              ((pilot - baseline) / baseline * 100)
            - 'multiplier': multiplicative change (pilot / baseline). E.g., 2.0 means pilot
              is 2x baseline
            Sorted by absolute value of percentage change (descending).
    """
    pivot = period_category_data.pivot(
        index="category", columns="period", values=metric
    ).reset_index()
    pivot["change"] = (pivot["pilot"] - pivot["baseline"]).round(2)
    pivot["pct_change"] = ((pivot["pilot"] - pivot["baseline"]) / pivot["baseline"] * 100).round(1)
    pivot["multiplier"] = (
        (pivot["pilot"] / pivot["baseline"]).round(2).replace([float("inf"), -float("inf")], None)
    )
    pivot = pivot.sort_values(by="pct_change", key=lambda x: x.abs(), ascending=False)
    return pivot


def calculate_plant_milk_percentage(
    period_category_data: pd.DataFrame, metric: str = "kilos per diner-meal"
) -> pd.Series | None:
    """
    Calculate the percentage of milk that is plant-based for each period.

    Args:
        period_category_data (pd.DataFrame): DataFrame with columns ['category', 'period',
            metric]. Must contain milk categories for both baseline and pilot periods.
        metric (str, optional): The column name to use for calculations. Defaults to
            "kilos per diner-meal".

    Returns:
        pd.Series: Series with 'baseline' and 'pilot' as index and plant-based milk
            percentage as values. Returns None if no plant-based milk categories are found
            in the data.
    """
    # Check if we have plant-based milk data
    plant_milks = ["soy milk", "oat milk", "almond/coconut milk"]
    milk_categories_in_data = period_category_data.loc[
        period_category_data["category"].str.contains("milk", case=False, na=False), "category"
    ].unique()

    has_plant_milk = any(milk in milk_categories_in_data for milk in plant_milks)

    if not has_plant_milk:
        print("Note: No plant-based milk categories found in data.")
        return None

    # Calculate total kilos of cow's milk for baseline and pilot
    milk_totals = (
        period_category_data.loc[period_category_data["category"] == "milk (cow's milk)"]
        .groupby("period")[metric]
        .sum()
    )

    # Calculate total kilos of plant-based milks (soy, oat, almond/coconut) for baseline and pilot
    plant_milk_totals = (
        period_category_data.loc[period_category_data["category"].isin(plant_milks)]
        .groupby("period")[metric]
        .sum()
    )

    # Calculate percentage of milk that is plant-based for each period
    pb_milk_percentage = (plant_milk_totals / (milk_totals + plant_milk_totals) * 100).round(1)

    return pb_milk_percentage


def calculate_monthly_plant_animal_split(monthly_category_data: pd.DataFrame) -> pd.DataFrame:
    """
    Calculate the percentage of plant-based protein vs animal protein for each month.

    This function provides month-by-month breakdown of plant vs animal protein distribution,
    useful for tracking trends over time within baseline or pilot periods.

    Args:
        monthly_category_data (pd.DataFrame): DataFrame with columns ['category', 'month_year',
            'kilos_total']. Categories should match GBD categories from YAML.

    Returns:
        pd.DataFrame: DataFrame with columns ['month_year', 'period', 'plant_kilos',
            'animal_kilos', 'total_kilos', 'plant_percentage', 'animal_percentage'].
            Kilos are rounded to nearest integer, percentages to 1 decimal place.
            month_year is formatted as 'Jan-2024'.

    Raises:
        ValueError: If the data contains categories not defined in the GBD categories YAML.

    Examples:
        >>> monthly_split = calculate_monthly_plant_animal_split(monthly_category_data)
    """
    # Get valid protein and animal categories from YAML (lowercase for comparison)
    valid_gbd_categories = set(get_GBD_categories(lowercase=True))
    protein_categories = set(get_protein_categories(lowercase=True))
    animal_proteins = set(get_animal_product_categories(lowercase=True))

    # Validate that all categories in the data are valid GBD categories
    data_categories = set(monthly_category_data["category"].str.lower().unique())
    invalid_categories = data_categories - valid_gbd_categories

    if invalid_categories:
        raise ValueError(
            f"The following categories are not defined in GBD categories: {invalid_categories}"
        )

    # Filter data for protein categories only
    protein_data = monthly_category_data[
        monthly_category_data["category"].str.lower().isin(protein_categories)
    ].copy()

    # Add animal/plant classification based on YAML data
    protein_data["protein_type"] = (
        protein_data["category"]
        .str.lower()
        .apply(lambda x: "animal" if x in animal_proteins else "plant")
    )

    # Group by month_year, period, and protein_type
    group_cols = ["month_year"]
    if "period" in protein_data.columns:
        group_cols.append("period")
    group_cols.append("protein_type")

    monthly_totals = protein_data.groupby(group_cols)["kilos_total"].sum().reset_index()

    # Pivot to get plant and animal columns side by side
    pivot_cols = ["month_year"]
    if "period" in monthly_totals.columns:
        pivot_cols.append("period")

    monthly_wide = monthly_totals.pivot_table(
        index=pivot_cols, columns="protein_type", values="kilos_total", fill_value=0
    ).reset_index()

    # Rename columns for clarity
    monthly_wide.columns.name = None
    monthly_wide.rename(columns={"animal": "animal_kilos", "plant": "plant_kilos"}, inplace=True)

    monthly_wide = monthly_wide.sort_values("month_year").reset_index(drop=True)

    # Calculate total and percentages
    monthly_wide["total_kilos"] = monthly_wide["animal_kilos"] + monthly_wide["plant_kilos"]
    monthly_wide["plant_percentage"] = (
        monthly_wide["plant_kilos"] / monthly_wide["total_kilos"] * 100
    ).round(1)
    monthly_wide["animal_percentage"] = (
        monthly_wide["animal_kilos"] / monthly_wide["total_kilos"] * 100
    ).round(1)

    monthly_wide["plant_kilos"] = monthly_wide["plant_kilos"].round(0).astype(int)
    monthly_wide["animal_kilos"] = monthly_wide["animal_kilos"].round(0).astype(int)
    monthly_wide["total_kilos"] = monthly_wide["total_kilos"].round(0).astype(int)

    if pd.api.types.is_period_dtype(monthly_wide["month_year"]):
        monthly_wide["month_year"] = monthly_wide["month_year"].dt.strftime("%b-%Y")
    else:
        monthly_wide["month_year"] = monthly_wide["month_year"].apply(
            lambda x: pd.to_datetime(x).strftime("%b-%Y") if isinstance(x, str) else str(x)
        )

    return monthly_wide


def calculate_monthly_milk_split(
    monthly_category_data: pd.DataFrame, print_table: bool = True
) -> pd.DataFrame | None:
    """
    Calculate the percentage of plant-based milk vs dairy milk for each month.

    This function provides month-by-month breakdown of plant vs dairy milk distribution,
    useful for tracking dairy displacement trends over time.

    Args:
        monthly_category_data (pd.DataFrame): DataFrame with columns ['category', 'month_year',
            'kilos_total']. Categories should match GBD categories from YAML.
        print_table (bool, optional): If True, prints a formatted table. Defaults to True.

    Returns:
        pd.DataFrame: DataFrame with columns ['month_year', 'period', 'plant_milk_kilos',
            'dairy_milk_kilos', 'total_milk_kilos', 'plant_milk_percentage',
            'dairy_milk_percentage']. Returns None if no milk categories are found in the data.

    Examples:
        >>> monthly_milk = calculate_monthly_milk_split(monthly_category_data)
        >>> # Or without printing
        >>> monthly_milk = calculate_monthly_milk_split(monthly_category_data, print_table=False)
    """
    dairy_categories = set(get_dairy_categories(lowercase=True))

    # Filter for milk-specific categories
    milk_keywords = ["milk", "dairy alternative"]
    milk_data = monthly_category_data[
        monthly_category_data["category"]
        .str.lower()
        .apply(lambda x: any(keyword in x for keyword in milk_keywords))
    ].copy()

    if milk_data.empty:
        if print_table:
            print("\nNo milk categories found in the data.\n")
        return None

    # Classify as dairy or plant milk
    milk_data["milk_type"] = (
        milk_data["category"]
        .str.lower()
        .apply(lambda x: "dairy" if x in dairy_categories else "plant")
    )

    group_cols = ["month_year"]
    if "period" in milk_data.columns:
        group_cols.append("period")
    group_cols.append("milk_type")

    monthly_totals = milk_data.groupby(group_cols)["kilos_total"].sum().reset_index()

    pivot_cols = ["month_year"]
    if "period" in monthly_totals.columns:
        pivot_cols.append("period")

    monthly_wide = monthly_totals.pivot_table(
        index=pivot_cols, columns="milk_type", values="kilos_total", fill_value=0
    ).reset_index()

    # Rename columns for clarity
    monthly_wide.columns.name = None
    monthly_wide.rename(
        columns={"dairy": "dairy_milk_kilos", "plant": "plant_milk_kilos"}, inplace=True
    )

    # Calculate total and percentages
    monthly_wide["total_milk_kilos"] = (
        monthly_wide["dairy_milk_kilos"] + monthly_wide["plant_milk_kilos"]
    )
    monthly_wide["plant_milk_percentage"] = (
        monthly_wide["plant_milk_kilos"] / monthly_wide["total_milk_kilos"] * 100
    ).round(1)
    monthly_wide["dairy_milk_percentage"] = (
        monthly_wide["dairy_milk_kilos"] / monthly_wide["total_milk_kilos"] * 100
    ).round(1)

    monthly_wide = monthly_wide.sort_values("month_year").reset_index(drop=True)

    if print_table:
        print("\n" + "=" * 95)
        print("MONTHLY PLANT-BASED VS DAIRY MILK SPLIT".center(95))
        print("=" * 95)

        display_df = monthly_wide.copy()

        if pd.api.types.is_period_dtype(display_df["month_year"]):
            display_df["Month"] = display_df["month_year"].astype(str)
        else:
            display_df["Month"] = display_df["month_year"].apply(
                lambda x: pd.to_datetime(x).strftime("%b-%Y") if isinstance(x, str) else str(x)
            )

        # Select and rename columns for display
        display_cols = ["Month"]
        if "period" in display_df.columns:
            display_df["Period"] = display_df["period"].str.title()
            display_cols.append("Period")

        display_df["Plant Milk (kg)"] = display_df["plant_milk_kilos"].round(1)
        display_df["Dairy Milk (kg)"] = display_df["dairy_milk_kilos"].round(1)
        display_df["Total Milk (kg)"] = display_df["total_milk_kilos"].round(1)
        display_df["Plant Milk %"] = display_df["plant_milk_percentage"].apply(
            lambda x: f"{x:.1f}%"
        )
        display_df["Dairy Milk %"] = display_df["dairy_milk_percentage"].apply(
            lambda x: f"{x:.1f}%"
        )

        display_cols.extend(
            [
                "Plant Milk (kg)",
                "Dairy Milk (kg)",
                "Total Milk (kg)",
                "Plant Milk %",
                "Dairy Milk %",
            ]
        )

        print("\n")
        print(display_df[display_cols].to_string(index=False))
        print("\n" + "=" * 95 + "\n")

    return monthly_wide
