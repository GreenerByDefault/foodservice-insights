import pandas as pd
import pytest
from gbd_foodservice_insights import emissions


def _known_category_with_us_factor() -> tuple[str, float]:
    factors = emissions.load_emission_factors()
    for category, values in factors.items():
        if values["us"] is not None:
            return category, float(values["us"])
    raise AssertionError("Expected at least one category with a US emission factor.")


def test_get_emission_factor_is_case_insensitive():
    """Ensures category lookup works regardless of category-name casing."""
    category, factor = _known_category_with_us_factor()
    assert emissions.get_emission_factor(category.lower(), region="us") == factor
    assert emissions.get_emission_factor(category.upper(), region="us") == factor


def test_get_emission_factor_invalid_region_raises():
    """Ensures unsupported region names fail fast instead of silently defaulting."""
    category, _ = _known_category_with_us_factor()
    with pytest.raises(ValueError, match="region must be one of"):
        emissions.get_emission_factor(category, region="mars")


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

    out_zero = emissions.calculate_emissions_per_diner_meal(summary, total_diner_meals=0)
    out_none = emissions.calculate_emissions_per_diner_meal(summary, total_diner_meals=None)

    assert pd.isna(out_zero.loc[0, "kg_co2e_per_diner_meal"])
    assert pd.isna(out_none.loc[0, "kg_co2e_per_diner_meal"])
