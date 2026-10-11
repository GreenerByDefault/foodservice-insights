import pandas as pd
import pytest
from gbd_foodservice_insights import emissions
from gbd_foodservice_insights.categories import categories
from gbd_foodservice_insights.report.schema import DinerOrMeal


def _known_category_with_us_factor() -> tuple[str, float]:
    category = categories()[0]
    return category.name, category.emission_factor_us


def test_get_emission_factor_matches_the_exact_name_only():
    category, factor = _known_category_with_us_factor()
    assert emissions.get_emission_factor(category, region="us") == factor
    assert emissions.get_emission_factor(category.lower(), region="us") is None


def test_calculate_emissions_multiplies_weight_by_factor():
    """Ensures core emissions math uses the category emission factor row-by-row."""
    category, factor = _known_category_with_us_factor()
    df = pd.DataFrame({"category": [category], "kilos_total": [2.5]})

    out = emissions.calculate_emissions(df, weight_col="kilos_total", category_col="category")

    assert out.at[0, "emission_factor_used"] == factor
    assert out.at[0, "emissions_kg_co2e"] == pytest.approx(2.5 * factor)


def test_calculate_emissions_summary_sorts_and_computes_percentages():
    """Ensures summary output is sorted and percent-of-total math is correct."""
    df = pd.DataFrame(
        {
            "category": ["A", "B"],
            "emissions_kg_co2e": [30.0, 10.0],
        }
    )

    summary = emissions.calculate_emissions_summary(df)

    assert summary["category"].tolist() == ["A", "B"]
    assert summary["total_kg_co2e"].tolist() == [30.0, 10.0]
    assert summary["pct_of_total"].tolist() == [75.0, 25.0]


def test_calculate_emissions_per_diner_meal_handles_zero_or_missing_denominator():
    """Ensures per-diner metrics do not divide by zero and remain missing when unsupported."""
    summary = pd.DataFrame({"category": ["A"], "total_kg_co2e": [10.0]})

    out_zero = emissions.calculate_emissions_per_diner_meal(summary, 0, "diner")
    out_none = emissions.calculate_emissions_per_diner_meal(summary, None, "diner")

    assert pd.isna(out_zero.loc[0, "kg_co2e_per_diner"])
    assert pd.isna(out_none.loc[0, "kg_co2e_per_diner"])


@pytest.mark.parametrize("diner_or_meal", ["diner", "meal"])
def test_calculate_emissions_per_diner_meal_rounds_to_three_significant_figures(
    diner_or_meal: DinerOrMeal,
):
    """A tiny category reads its magnitude instead of rounding down to 0.0."""
    summary = pd.DataFrame({"category": ["Spices"], "total_kg_co2e": [0.0000312]})

    out = emissions.calculate_emissions_per_diner_meal(summary, 1, diner_or_meal)

    assert out.loc[0, f"kg_co2e_per_{diner_or_meal}"] == pytest.approx(0.0000312)
