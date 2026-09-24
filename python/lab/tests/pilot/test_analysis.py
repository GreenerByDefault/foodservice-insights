"""
Tests for the split pilot analysis modules.

This module tests pilot analysis and result visualization functions.
"""

import matplotlib
import pandas as pd
import pytest

matplotlib.use("Agg")  # Use non-interactive backend for testing
import matplotlib.pyplot as plt
from gbd_foodservice_insights_lab.pilot.analysis import (
    analyze_meat_consumption,
    calculate_meat_averted,
    calculate_product_overlap,
    compare_plant_based_product_counts,
    plant_animal_split,
)
from gbd_foodservice_insights_lab.pilot.plots import (
    plot_plant_animal_split,
    print_plant_based_product_changes,
    print_product_overlap_summary,
)

# ----------------------------------------------------------------------
# Fixtures
# ----------------------------------------------------------------------


@pytest.fixture
def sample_monthly_product_data():
    """Sample monthly product data with baseline and pilot periods."""
    data = {
        "product_name": [
            "Apple",
            "Banana",
            "Orange",
            "Apple",  # Same as baseline (should be in overlap)
            "Banana",  # Same as baseline (should be in overlap)
            "Grapes",  # New in pilot
            "APPLE",  # Same as baseline, different case (should be in overlap)
            "  Orange  ",  # Same as baseline, with whitespace (should be in overlap)
        ],
        "period": [
            "baseline",
            "baseline",
            "baseline",
            "pilot",
            "pilot",
            "pilot",
            "pilot",
            "pilot",
        ],
        "month_year": [
            "2023-01",
            "2023-01",
            "2023-02",
            "2023-03",
            "2023-03",
            "2023-04",
            "2023-04",
            "2023-05",
        ],
    }
    return pd.DataFrame(data)


def test_calculate_product_overlap_basic(sample_monthly_product_data):
    result = calculate_product_overlap(sample_monthly_product_data)

    # Baseline has 3 unique products: apple, banana, orange
    assert result["baseline_unique"] == 3

    # Pilot has 4 unique products: apple, banana, orange, grapes
    assert result["pilot_unique"] == 4

    # 3 products overlap: apple, banana, orange (case-insensitive and whitespace-stripped)
    assert result["overlap_count"] == 3

    # 3/3 = 100% overlap
    assert result["overlap_percentage"] == 100.0


def test_calculate_product_overlap_no_overlap():
    data = {
        "product_name": ["Apple", "Banana", "Orange", "Grapes", "Melon", "Kiwi"],
        "period": ["baseline", "baseline", "baseline", "pilot", "pilot", "pilot"],
        "month_year": ["2023-01", "2023-01", "2023-02", "2023-03", "2023-03", "2023-04"],
    }
    df = pd.DataFrame(data)
    result = calculate_product_overlap(df)

    assert result["baseline_unique"] == 3
    assert result["pilot_unique"] == 3
    assert result["overlap_count"] == 0
    assert result["overlap_percentage"] == 0.0


def test_calculate_product_overlap_complete_overlap():
    data = {
        "product_name": ["Apple", "Banana", "Apple", "Banana", "Orange"],
        "period": ["baseline", "baseline", "pilot", "pilot", "pilot"],
        "month_year": ["2023-01", "2023-01", "2023-03", "2023-03", "2023-04"],
    }
    df = pd.DataFrame(data)
    result = calculate_product_overlap(df)

    assert result["baseline_unique"] == 2  # apple, banana
    assert result["pilot_unique"] == 3  # apple, banana, orange
    assert result["overlap_count"] == 2
    assert result["overlap_percentage"] == 100.0


def test_calculate_product_overlap_partial_overlap():
    data = {
        "product_name": ["Apple", "Banana", "Orange", "Melon", "Apple", "Kiwi", "Grapes"],
        "period": ["baseline", "baseline", "baseline", "baseline", "pilot", "pilot", "pilot"],
        "month_year": ["2023-01", "2023-01", "2023-02", "2023-02", "2023-03", "2023-03", "2023-04"],
    }
    df = pd.DataFrame(data)
    result = calculate_product_overlap(df)

    assert result["baseline_unique"] == 4  # apple, banana, orange, melon
    assert result["pilot_unique"] == 3  # apple, kiwi, grapes
    assert result["overlap_count"] == 1  # only apple
    assert result["overlap_percentage"] == 25.0  # 1/4 = 25%


def test_calculate_product_overlap_empty_baseline():
    data = {
        "product_name": ["Apple", "Banana"],
        "period": ["pilot", "pilot"],
        "month_year": ["2023-03", "2023-03"],
    }
    df = pd.DataFrame(data)
    result = calculate_product_overlap(df)

    assert result["baseline_unique"] == 0
    assert result["pilot_unique"] == 2
    assert result["overlap_count"] == 0
    assert result["overlap_percentage"] == 0.0


def test_compare_plant_based_product_counts_returns_detailed_breakdown():
    """Checks the plant-based comparison table includes category-level counts and product churn
    details."""
    df = pd.DataFrame(
        {
            "product": [
                "Black Beans",
                "Chickpeas",
                "Black Beans",
                "Lentils",
                "Impossible Burger",
                "Black Bean Burger",
                "Impossible Burger",
                "Whole Wheat Pasta",
            ],
            "category": [
                "Legumes",
                "Legumes",
                "Legumes",
                "Legumes",
                "Plant-based Meats",
                "Plant-based Meats",
                "Plant-based Meats",
                "Whole Grains",
            ],
            "period": [
                "baseline",
                "baseline",
                "pilot",
                "pilot",
                "baseline",
                "pilot",
                "pilot",
                "pilot",
            ],
        }
    )

    result = compare_plant_based_product_counts(df)

    legumes = result.loc[result["category"] == "Legumes"].iloc[0]
    assert legumes["baseline_count"] == 2
    assert legumes["pilot_count"] == 2
    assert legumes["change"] == 0
    assert legumes["retained_count"] == 1
    assert legumes["products_added_count"] == 1
    assert legumes["products_removed_count"] == 1
    assert legumes["products_added"] == ["Lentils"]
    assert legumes["products_removed"] == ["Chickpeas"]

    plant_meats = result.loc[result["category"] == "Plant-based Meats"].iloc[0]
    assert plant_meats["baseline_count"] == 1
    assert plant_meats["pilot_count"] == 2
    assert plant_meats["change"] == 1
    assert bool(plant_meats["increased"]) is True
    assert plant_meats["products_added"] == ["Black Bean Burger"]
    assert plant_meats["products_removed"] == []

    whole_grains = result.loc[result["category"] == "Whole Grains"].iloc[0]
    assert whole_grains["baseline_count"] == 0
    assert whole_grains["pilot_count"] == 1
    assert pd.isna(whole_grains["pct_change"])


def test_compare_plant_based_product_counts_includes_missing_yaml_categories():
    """Checks the result covers the full plant-based meta category, even when some categories have
    zero products."""
    df = pd.DataFrame(
        {
            "product": ["Black Beans"],
            "category": ["Legumes"],
            "period": ["baseline"],
        }
    )

    result = compare_plant_based_product_counts(df)

    assert "Soy Milk" in result["category"].values
    soy_milk = result.loc[result["category"] == "Soy Milk"].iloc[0]
    assert soy_milk["baseline_count"] == 0
    assert soy_milk["pilot_count"] == 0
    assert soy_milk["products_added"] == []
    assert soy_milk["products_removed"] == []


def test_print_plant_based_product_changes_shows_detailed_lists(capsys):
    """Checks the notebook-facing summary prints added and removed products clearly."""
    comparison = pd.DataFrame(
        {
            "category": ["Legumes"],
            "baseline_count": [2],
            "pilot_count": [3],
            "change": [1],
            "pct_change": [50.0],
            "products_added_count": [2],
            "products_removed_count": [1],
            "increased": [True],
            "products_added": [["Lentils", "White Beans"]],
            "products_removed": [["Chickpeas"]],
        }
    )

    print_plant_based_product_changes(comparison)
    captured = capsys.readouterr()

    assert "Added in pilot: Lentils, White Beans" in captured.out
    assert "Removed after baseline: Chickpeas" in captured.out
    assert "✓ Increased" in captured.out


def test_calculate_product_overlap_normalization(sample_monthly_product_data):
    result = calculate_product_overlap(sample_monthly_product_data)

    # The normalization should make 'Apple', 'APPLE' be treated as the same
    # and 'Orange', '  Orange  ' be treated as the same
    assert result["overlap_count"] == 3  # apple, banana, orange


def test_print_product_overlap_summary(sample_monthly_product_data, capsys):
    overlap_dict = calculate_product_overlap(sample_monthly_product_data)
    print_product_overlap_summary(overlap_dict)

    captured = capsys.readouterr()

    # Check that key information is in the output
    assert "Product Name Overlap Analysis" in captured.out
    assert "3" in captured.out  # baseline_unique
    assert "4" in captured.out  # pilot_unique
    assert "100.0%" in captured.out  # overlap_percentage
    assert "High overlap" in captured.out  # interpretation


def test_print_product_overlap_summary_low_overlap(capsys):
    overlap_dict = {
        "baseline_unique": 100,
        "pilot_unique": 80,
        "overlap_count": 30,
        "overlap_percentage": 30.0,
    }
    print_product_overlap_summary(overlap_dict)

    captured = capsys.readouterr()
    assert "Low overlap" in captured.out
    assert "Significant menu changes" in captured.out


def test_print_product_overlap_summary_moderate_overlap(capsys):
    overlap_dict = {
        "baseline_unique": 100,
        "pilot_unique": 90,
        "overlap_count": 65,
        "overlap_percentage": 65.0,
    }
    print_product_overlap_summary(overlap_dict)

    captured = capsys.readouterr()
    assert "Moderate overlap" in captured.out


# ----------------------------------------------------------------------
# Tests for plant_animal_split
# ----------------------------------------------------------------------


class TestPlantAnimalSplit:
    """Tests for plant_animal_split function."""

    @pytest.fixture
    def sample_monthly_category_data(self):
        """Sample monthly category data for testing with actual GBD category names."""
        data = {
            # Use actual GBD category names
            "category": [
                "beef and buffalo meat",
                "poultry (chicken & turkey)",
                "legumes",
                "whole grains",
                "beef and buffalo meat",
                "poultry (chicken & turkey)",
                "legumes",
                "whole grains",
            ],
            "month_year": [
                "2024-01",
                "2024-01",
                "2024-01",
                "2024-01",
                "2024-02",
                "2024-02",
                "2024-02",
                "2024-02",
            ],
            "kilos_total": [100, 50, 30, 70, 90, 60, 40, 80],
            "period": [
                "baseline",
                "baseline",
                "baseline",
                "baseline",
                "pilot",
                "pilot",
                "pilot",
                "pilot",
            ],
        }
        return pd.DataFrame(data)

    def test_returns_series(self, sample_monthly_category_data):
        result = plant_animal_split(sample_monthly_category_data)
        assert isinstance(result, pd.Series)

    def test_calculates_plant_percentage(self, sample_monthly_category_data):
        result = plant_animal_split(sample_monthly_category_data)
        # Result should contain percentage values
        assert all(0 <= val <= 100 for val in result.values)


def test_analyze_meat_consumption_returns_expected_averted_values():
    """Verifies meat-averted outputs use baseline rate x pilot meals and format summary values
    consistently."""
    period_category_data = pd.DataFrame(
        {
            "category": [
                "beef and buffalo meat",
                "poultry (chicken & turkey)",
                "legumes",
                "beef and buffalo meat",
                "poultry (chicken & turkey)",
                "legumes",
            ],
            "period": [
                "baseline",
                "baseline",
                "baseline",
                "pilot",
                "pilot",
                "pilot",
            ],
            "kilos_total": [100.0, 50.0, 25.0, 60.0, 40.0, 30.0],
        }
    )
    diner_meal_data = pd.DataFrame(
        {
            "period": ["baseline", "pilot"],
            "diner-meals": [1000, 1200],
        }
    )

    per_diner_meal, summary, averted_summary = analyze_meat_consumption(
        period_category_data, diner_meal_data
    )

    assert per_diner_meal["baseline"] == pytest.approx(0.15)
    assert per_diner_meal["pilot"] == pytest.approx(100 / 1200)
    assert summary.loc[summary["Period"] == "Baseline", "Total Meat (kg)"].iloc[0] == 150.0
    assert summary.loc[summary["Period"] == "Pilot", "Total Meat (kg)"].iloc[0] == 100.0

    metric_to_value = dict(zip(averted_summary["Metric"], averted_summary["Value"], strict=True))
    assert metric_to_value["Expected meat consumption (kg)"] == "180.0"
    assert metric_to_value["Actual meat consumption (kg)"] == "100.0"
    assert metric_to_value["Meat averted (kg)"] == "80.0"
    assert metric_to_value["Meat averted (tonnes)"] == "0.08"


def test_calculate_meat_averted_raises_migration_error():
    """Ensures deprecated helper fails loudly with migration guidance."""
    with pytest.raises(NotImplementedError, match="has been removed"):
        calculate_meat_averted(
            meat_per_diner_meal=pd.Series({"baseline": 0.1, "pilot": 0.05}),
            diner_meal_data=pd.DataFrame(
                {"period": ["baseline", "pilot"], "diner-meals": [100, 100]}
            ),
        )


# ----------------------------------------------------------------------
# Tests for plotting functions
# ----------------------------------------------------------------------


class TestPlotPlantAnimalSplit:
    """Tests for plot_plant_animal_split function."""

    def test_returns_figure(self):
        # Create sample data: Series with period index and plant percentage values
        plant_pcts = pd.Series({"baseline": 40.0, "pilot": 50.0})
        fig = plot_plant_animal_split(plant_pcts)
        assert isinstance(fig, plt.Figure)
        plt.close(fig)

    def test_custom_figsize(self):
        plant_pcts = pd.Series({"baseline": 40.0, "pilot": 50.0})
        fig = plot_plant_animal_split(plant_pcts, figsize=(12, 4))
        assert isinstance(fig, plt.Figure)
        plt.close(fig)


# Clean up matplotlib
@pytest.fixture(autouse=True)
def cleanup_plt():
    """Clean up matplotlib figures after each test."""
    yield
    plt.close("all")
