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
    """Load a sheet from the baseline and pilot Excel files and combine them.

    By default the frames are concatenated with a ``period`` column of ``"baseline"`` or
    ``"pilot"``; ``merge_on_category`` instead inner-joins them on ``category`` and ignores
    ``drop_total_row`` and ``validate_months``. ``drop_total_column`` drops the ``total``
    column. ``drop_total_row`` assumes transposed data: it renames ``index`` and ``0`` to
    ``month_year`` and ``diner-meals``, then drops the ``month_year == "total"`` row.
    ``validate_months`` asserts both periods have the same number of unique ``month_year``
    values.
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
    """Load and merge template data from the baseline and pilot "Template Data" sheets.

    The result has columns from both periods.
    """
    return _load_and_concat_data(
        baseline_input_file,
        pilot_input_file,
        sheet_name="Template Data",
        drop_total_column=True,
        merge_on_category=True,
    )


def load_monthly_product_data(baseline_input_file: str, pilot_input_file: str) -> pd.DataFrame:
    """Load and combine the baseline and pilot "Monthly Product Data" sheets.

    A ``period`` column marks each row as baseline or pilot.
    """
    return _load_and_concat_data(
        baseline_input_file, pilot_input_file, sheet_name="Monthly Product Data"
    )


def load_monthly_category_data(baseline_input_file: str, pilot_input_file: str) -> pd.DataFrame:
    """Load and combine the baseline and pilot "Monthly Category Data" sheets.

    A ``period`` column marks each row as baseline or pilot.
    """
    return _load_and_concat_data(
        baseline_input_file, pilot_input_file, sheet_name="Monthly Category Data"
    )


def load_diner_meal_data(
    baseline_input_file: str, pilot_input_file: str, validate_months: bool = True
) -> pd.DataFrame:
    """Load and combine the baseline and pilot "Diner-Meal Numbers" sheets.

    Returns ``month_year``, ``diner-meals``, and ``period`` columns, without the ``total``
    row. ``validate_months`` checks both periods have the same number of months.
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
    """Load and combine the baseline and pilot "Monthly Product x category Data" sheets.

    A ``period`` column marks each row as baseline or pilot.
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
    """Load all pilot analysis datasets in one call.

    Returns a dict of DataFrames keyed by ``template_data``, ``monthly_product_data``,
    ``monthly_category_data``, ``diner_meal_data``, ``monthly_product_category_data``, and
    ``period_category_data`` (period-level category totals with kilos per diner-meal).
    ``include_total_meat`` adds an aggregate "total meat" category to
    ``period_category_data``; ``validate_months`` checks both periods have the same number
    of months.
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
    """Calculate the overlap of unique product names between baseline and pilot periods.

    Names are normalized (lowercase, strip whitespace) before comparing. The overlap helps
    assess whether changes in metrics are due to menu composition shifts vs actual
    intervention effects.

    ``monthly_product_data`` needs ``product_name`` and ``period`` columns. Returns
    ``baseline_unique``, ``pilot_unique``, ``overlap_count``, and ``overlap_percentage``
    (the percentage of baseline products appearing in pilot).
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
    """Calculate the percentage of plant-based protein vs animal protein for each period.

    ``monthly_category_data`` needs ``category``, ``period``, and ``kilos_total`` columns.
    Returns the plant-based percentage indexed by period. Raises ``ValueError`` if the data
    contains categories not defined in the GBD categories YAML.
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
    """Compare the number of unique plant-based products between baseline and pilot periods.

    Filters to the plant-based categories in GBD_categories.yaml and, per category, also
    lists which products were added or removed, so the notebook can explain not just
    whether counts changed but how the mix changed. Display it with
    ``print_plant_based_product_changes``.

    ``monthly_product_category_data`` needs ``product``, ``category``, and ``period``
    (``"baseline"`` / ``"pilot"``) columns. Returns one row per plant-based category
    (``meta_category`` is always ``"Plant-Based"``) with ``baseline_count``,
    ``pilot_count``, ``change`` (pilot - baseline), ``pct_change``, ``retained_count``,
    ``products_added_count``, ``products_removed_count``, ``increased``, and the product-name
    lists ``baseline_products``, ``pilot_products``, ``products_added``, and
    ``products_removed``. Sorted by absolute change, descending.
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
    """Analyze consumption for any combination of categories, comparing baseline and pilot.

    ``period_category_data`` needs ``category``, ``period``, and ``kilos_total`` columns;
    ``diner_meal_data`` needs ``period`` and ``diner-meals`` columns. When ``categories`` is
    None, they are looked up from ``category_label`` (e.g. "Meat", "Dairy", "Animal Products",
    "Eggs"), which also labels the output.

    Returns consumption per diner-meal (kg) for baseline and pilot, a summary with totals,
    diner-meals, and per-diner-meal metrics, and an averted summary with expected
    consumption, actual consumption, and averted metrics.
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
    """Analyze meat consumption comparing baseline and pilot periods, including meat averted.

    ``period_category_data`` must contain meat categories for both periods. See
    ``analyze_category_consumption`` for the input columns and the three returned values.
    """
    return analyze_category_consumption(
        period_category_data=period_category_data,
        diner_meal_data=diner_meal_data,
        category_label="Meat",
    )


def analyze_animal_product_consumption(
    period_category_data: pd.DataFrame, diner_meal_data: pd.DataFrame
) -> tuple[pd.Series, pd.DataFrame, pd.DataFrame]:
    """Analyze animal product (meat, dairy, eggs) consumption, comparing baseline and pilot.

    See ``analyze_category_consumption`` for the input columns and the three returned values.
    """
    return analyze_category_consumption(
        period_category_data=period_category_data,
        diner_meal_data=diner_meal_data,
        category_label="Animal Products",
    )


def analyze_milk_consumption(
    period_category_data: pd.DataFrame, diner_meal_data: pd.DataFrame
) -> tuple[pd.Series, pd.DataFrame, pd.DataFrame]:
    """Analyze milk consumption comparing baseline and pilot periods.

    See ``analyze_category_consumption`` for the input columns and the three returned values.
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
    """Create period-level category data with kilos per diner_meal calculations.

    ``monthly_category_data`` needs ``category``, ``period``, and ``kilos_total`` columns;
    ``diner_meal_data`` needs ``period`` and ``diner-meals`` columns. ``include_total_meat``
    adds an aggregate "total meat" category combining beef, pork, and poultry. Returns
    ``category``, ``period``, ``kilos_total``, ``diner-meals``, and ``kilos per diner-meal``
    columns.
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
    """Compare baseline and pilot values of ``metric`` for each category.

    ``period_category_data`` needs ``category``, ``period``, and ``metric`` columns, with
    both periods for every category. Returns ``category``, ``baseline``, ``pilot``,
    ``change`` (pilot - baseline), ``pct_change`` ((pilot - baseline) / baseline * 100), and
    ``multiplier`` (pilot / baseline, so 2.0 means pilot is 2x baseline), sorted by absolute
    ``pct_change``, descending.
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
    """Calculate the percentage of milk that is plant-based for each period.

    ``period_category_data`` needs ``category``, ``period``, and ``metric`` columns, with
    milk categories for both periods. Returns percentages indexed by ``"baseline"`` and
    ``"pilot"``, or None if the data has no plant-based milk categories.
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
    """Calculate the percentage of plant-based protein vs animal protein for each month.

    ``monthly_category_data`` needs ``category``, ``month_year``, and ``kilos_total``
    columns. Returns a DataFrame with ``month_year`` (formatted like ``Jan-2024``), ``period``,
    ``plant_kilos``, ``animal_kilos``, ``total_kilos``, ``plant_percentage``, and
    ``animal_percentage`` columns; kilos are rounded to integers and percentages to one
    decimal place. Raises ``ValueError`` if the data contains categories not defined in the
    GBD categories YAML.
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

    if isinstance(monthly_wide["month_year"].dtype, pd.PeriodDtype):
        monthly_wide["month_year"] = monthly_wide["month_year"].dt.strftime("%b-%Y")
    else:
        monthly_wide["month_year"] = monthly_wide["month_year"].apply(
            lambda x: pd.to_datetime(x).strftime("%b-%Y") if isinstance(x, str) else str(x)
        )

    return monthly_wide


def calculate_monthly_milk_split(
    monthly_category_data: pd.DataFrame, print_table: bool = True
) -> pd.DataFrame | None:
    """Calculate the percentage of plant-based milk vs dairy milk for each month.

    ``monthly_category_data`` needs ``category``, ``month_year``, and ``kilos_total``
    columns. Returns ``month_year``, ``period``, ``plant_milk_kilos``, ``dairy_milk_kilos``,
    ``total_milk_kilos``, ``plant_milk_percentage``, and ``dairy_milk_percentage`` columns,
    or None if the data has no milk categories.
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

        if isinstance(display_df["month_year"].dtype, pd.PeriodDtype):
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
