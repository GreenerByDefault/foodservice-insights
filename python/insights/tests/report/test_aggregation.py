from unittest.mock import patch

import pandas as pd
import pytest
from gbd_foodservice_insights.report.aggregation import (
    calculate_animal_emissions_concentration,
    calculate_milk_oat_swap_scenarios,
    calculate_plant_animal_split,
    calculate_plant_protein_share,
    calculate_ruminant_legume_swap_scenarios,
    create_template_data,
    run_aggregation_pipeline,
)


def test_calculate_ruminant_legume_swap_scenarios_uses_legume_counterfactual():
    """Ensures the swap table quantifies avoided emissions for ruminant-to-legume swaps only."""
    df = pd.DataFrame(
        {
            "month_year": ["2024-01", "2024-01", "2024-02"],
            "category": [
                "Beef and Buffalo Meat",
                "Lamb/mutton & goat meat",
                "Legumes",
            ],
            "product": ["beef mince", "lamb shoulder", "lentils"],
            "kilos_total": [10.0, 5.0, 8.0],
            "emissions_kg_co2e": [413.5, 208.1, 12.8],
        }
    )

    result = calculate_ruminant_legume_swap_scenarios(df, region="us")

    assert result["scenario"].tolist() == [
        "10% ruminant-to-legume swap",
        "25% ruminant-to-legume swap",
        "50% ruminant-to-legume swap",
        "100% ruminant-to-legume swap",
    ]
    assert result["baseline_ruminant_weight_kg"].tolist() == [15.0, 15.0, 15.0, 15.0]
    assert result["baseline_ruminant_emissions_kg_co2e"].tolist() == [621.6] * 4
    assert result.loc[0, "replaced_weight_kg"] == pytest.approx(1.5)
    assert result.loc[0, "avoidable_kg_co2e"] == pytest.approx(59.76)
    assert result.loc[0, "projected_emissions_kg_co2e"] == pytest.approx(561.84)
    assert result.loc[0, "institution_emissions_avoided_pct"] == pytest.approx(9.42)
    assert result.loc[3, "projected_emissions_kg_co2e"] == pytest.approx(24.0)
    assert result.loc[3, "replacement_category"] == "Legumes"


def test_calculate_milk_oat_swap_scenarios_uses_oat_milk_counterfactual():
    """Milk substitutions should quantify avoided emissions against total institution emissions."""
    df = pd.DataFrame(
        {
            "month_year": ["2024-01", "2024-02", "2024-02"],
            "category": ["Milk (Cow's milk)", "Oat Milk", "Legumes"],
            "product": ["whole milk", "oat milk", "lentils"],
            "kilos_total": [20.0, 4.0, 8.0],
            "emissions_kg_co2e": [43.4, 3.56, 12.8],
        }
    )

    result = calculate_milk_oat_swap_scenarios(df, region="us")

    assert result["scenario"].tolist() == [
        "10% cow's-milk-to-oat-milk swap",
        "20% cow's-milk-to-oat-milk swap",
        "50% cow's-milk-to-oat-milk swap",
        "100% cow's-milk-to-oat-milk swap",
    ]
    assert result["replacement_category"].tolist() == ["Oat Milk"] * 4
    assert result["baseline_ruminant_emissions_kg_co2e"].tolist() == [43.4] * 4
    assert result.loc[0, "avoidable_kg_co2e"] == pytest.approx(2.56)
    assert result.loc[0, "institution_emissions_avoided_pct"] == pytest.approx(4.28)
    assert result.loc[3, "projected_emissions_kg_co2e"] == pytest.approx(17.8)


def test_run_aggregation_pipeline_returns_substitution_scenarios_for_procurement():
    """Ensures procurement aggregation payloads carry the substitution sheet to Excel writers."""
    df = pd.DataFrame(
        {
            "month_year": ["2024-01", "2024-02", "2024-02"],
            "category": ["Beef and Buffalo Meat", "Lamb/mutton & goat meat", "Milk (Cow's milk)"],
            "product": ["beef mince", "lamb shoulder", "whole milk"],
            "kilos_total": [10.0, 5.0, 20.0],
            "emissions_kg_co2e": [413.5, 208.1, 65.6],
        }
    )

    result = run_aggregation_pipeline(
        df,
        diner_meal_mapping={"2024-01": 100.0, "2024-02": 120.0},
        region="us",
    )

    substitution_scenarios = result["substitution_scenarios"]

    assert not substitution_scenarios.empty
    assert "avoidable_kg_co2e" in substitution_scenarios.columns
    assert "institution_emissions_avoided_pct" in substitution_scenarios.columns
    assert substitution_scenarios["scenario"].tolist() == [
        "10% ruminant-to-legume swap",
        "25% ruminant-to-legume swap",
        "50% ruminant-to-legume swap",
        "100% ruminant-to-legume swap",
        "10% cow's-milk-to-oat-milk swap",
        "20% cow's-milk-to-oat-milk swap",
        "50% cow's-milk-to-oat-milk swap",
        "100% cow's-milk-to-oat-milk swap",
    ]


def test_create_template_data_preserves_values_when_category_case_differs():
    """Template rows should align to canonical GBD labels without zeroing case-mismatched data."""
    monthly_category_data = pd.DataFrame(
        {
            "month_year": ["2024-01", "2024-01", "2024-02"],
            "category": ["Legumes", "Cheese", "Milk (Cow's milk)"],
            "kilos_total": [12.5, 8.0, 30.0],
        }
    )

    template = create_template_data(monthly_category_data, "kilos_total")

    assert template.loc["Legumes", "2024-01"] == pytest.approx(12.5)
    assert template.loc["Cheese", "2024-01"] == pytest.approx(8.0)
    assert template.loc["Milk (Cow's milk)", "2024-02"] == pytest.approx(30.0)
    assert template.loc["total", "total"] == pytest.approx(50.5)


def test_calculate_plant_animal_split_is_case_insensitive_and_keeps_one_sided_months():
    """Plant-vs-animal summaries should keep months where one side is absent instead of dropping
    them."""
    df = pd.DataFrame(
        {
            "month_year": ["2024-01", "2024-02", "2024-02"],
            "category": ["lEgUmEs", "BEEF", "Other"],
            "kilos_total": [4.0, 3.0, 99.0],
        }
    )

    with (
        patch(
            "gbd_foodservice_insights.report.aggregation.get_animal_product_categories",
            return_value=["Beef"],
        ),
        patch(
            "gbd_foodservice_insights.report.aggregation.get_plant_based_categories",
            return_value=["Legumes"],
        ),
    ):
        result = calculate_plant_animal_split(df)

    assert result is not None
    monthly = result["monthly"]
    assert monthly is not None
    assert result["plant_kg"] == pytest.approx(4.0)
    assert result["animal_kg"] == pytest.approx(3.0)
    assert result["plant_pct"] == pytest.approx(57.1)
    assert result["animal_pct"] == pytest.approx(42.9)
    assert monthly["month_year"].tolist() == ["2024-01", "2024-02"]
    assert monthly["plant"].tolist() == [4.0, 0.0]
    assert monthly["animal"].tolist() == [0.0, 3.0]
    assert monthly["plant_pct"].tolist() == [100.0, 0.0]


def test_calculate_plant_animal_split_returns_none_when_no_relevant_rows():
    """Rows outside the plant and animal groups should not create a misleading split."""
    df = pd.DataFrame(
        {
            "month_year": ["2024-01"],
            "category": ["Other"],
            "kilos_total": [5.0],
        }
    )

    with (
        patch(
            "gbd_foodservice_insights.report.aggregation.get_animal_product_categories",
            return_value=["Beef"],
        ),
        patch(
            "gbd_foodservice_insights.report.aggregation.get_plant_based_categories",
            return_value=["Legumes"],
        ),
    ):
        result = calculate_plant_animal_split(df)

    assert result is None


def test_calculate_plant_protein_share_ignores_non_protein_rows_and_keeps_months():
    """Protein-share summaries should ignore non-protein rows but still keep one-sided months."""
    df = pd.DataFrame(
        {
            "month_year": ["2024-01", "2024-02", "2024-02"],
            "category": ["LEGUMES", "beef", "Vegetables"],
            "kilos_total": [4.0, 6.0, 100.0],
        }
    )

    with (
        patch(
            "gbd_foodservice_insights.report.aggregation.get_protein_categories",
            return_value=["Legumes", "Beef"],
        ),
        patch(
            "gbd_foodservice_insights.report.aggregation.get_plant_protein_categories",
            return_value=["Legumes"],
        ),
    ):
        result = calculate_plant_protein_share(df)

    assert result is not None
    monthly = result["monthly"]
    assert monthly is not None
    assert result["plant_protein_total"] == pytest.approx(4.0)
    assert result["total_protein_metric"] == pytest.approx(10.0)
    assert result["plant_protein_pct"] == pytest.approx(40.0)
    assert monthly["month_year"].tolist() == ["2024-01", "2024-02"]
    assert monthly["plant_protein_metric"].tolist() == [4.0, 0.0]
    assert monthly["total_protein_metric"].tolist() == [4.0, 6.0]
    assert monthly["plant_protein_pct"].tolist() == [100.0, 0.0]


def test_calculate_plant_protein_share_returns_none_when_total_protein_metric_is_zero():
    """Zero protein totals should not produce a headline percentage."""
    df = pd.DataFrame(
        {
            "month_year": ["2024-01", "2024-02"],
            "category": ["Legumes", "Beef"],
            "kilos_total": [0.0, 0.0],
        }
    )

    with (
        patch(
            "gbd_foodservice_insights.report.aggregation.get_protein_categories",
            return_value=["Legumes", "Beef"],
        ),
        patch(
            "gbd_foodservice_insights.report.aggregation.get_plant_protein_categories",
            return_value=["Legumes"],
        ),
    ):
        result = calculate_plant_protein_share(df)

    assert result is None


def test_calculate_animal_emissions_concentration_only_uses_animal_rows():
    """The animal-emissions KPI should ignore non-animal rows in its denominator and ranking."""
    df = pd.DataFrame(
        {
            "product": ["burger", "cheddar", "lentils"],
            "category": ["Beef", "Cheese", "Legumes"],
            "emissions_kg_co2e": [8.0, 2.0, 100.0],
        }
    )

    with patch(
        "gbd_foodservice_insights.report.aggregation.get_animal_product_categories",
        return_value=["Beef", "Cheese"],
    ):
        result = calculate_animal_emissions_concentration(df, top_n=1)

    assert result["KPI"].iloc[0] == "Top 1 animal products share of animal-product emissions"
    assert result["Value"].iloc[0] == pytest.approx(80.0)
    assert result["Top products"].iloc[0] == "burger"
    assert result["Top product emissions (kg CO2e)"].iloc[0] == pytest.approx(8.0)
    assert result["Total animal emissions (kg CO2e)"].iloc[0] == pytest.approx(10.0)


def test_calculate_animal_emissions_concentration_uses_actual_count_when_top_n_too_large():
    """The KPI label should reflect how many animal products actually exist."""
    df = pd.DataFrame(
        {
            "product": ["burger", "cheddar"],
            "category": ["Beef", "Cheese"],
            "emissions_kg_co2e": [8.0, 2.0],
        }
    )

    with patch(
        "gbd_foodservice_insights.report.aggregation.get_animal_product_categories",
        return_value=["Beef", "Cheese"],
    ):
        result = calculate_animal_emissions_concentration(df, top_n=5)

    assert result["KPI"].iloc[0] == "Top 2 animal products share of animal-product emissions"
    assert result["Value"].iloc[0] == pytest.approx(100.0)


def test_calculate_animal_emissions_concentration_returns_empty_when_animal_emissions_total_zero():
    """Zero animal emissions should not produce a misleading concentration KPI."""
    df = pd.DataFrame(
        {
            "product": ["burger", "cheddar"],
            "category": ["Beef", "Cheese"],
            "emissions_kg_co2e": [0.0, 0.0],
        }
    )

    with patch(
        "gbd_foodservice_insights.report.aggregation.get_animal_product_categories",
        return_value=["Beef", "Cheese"],
    ):
        result = calculate_animal_emissions_concentration(df, top_n=2)

    assert result.empty


def test_calculate_animal_emissions_concentration_uses_missing_product_name_fallback():
    """Missing product names should stay visible in the KPI output instead of being dropped."""
    df = pd.DataFrame(
        {
            "product": [pd.NA, "cheddar"],
            "category": ["Beef", "Cheese"],
            "emissions_kg_co2e": [5.0, 3.0],
        }
    )

    with patch(
        "gbd_foodservice_insights.report.aggregation.get_animal_product_categories",
        return_value=["Beef", "Cheese"],
    ):
        result = calculate_animal_emissions_concentration(df, top_n=2)

    assert result["Top products"].iloc[0] == "Missing product name | cheddar"


def test_calculate_ruminant_legume_swap_scenarios_returns_empty_when_no_source_rows_exist():
    """If no ruminant rows are present, the swap table should be empty rather than erroring."""
    df = pd.DataFrame(
        {
            "category": ["Legumes", "Vegetables"],
            "kilos_total": [10.0, 5.0],
            "emissions_kg_co2e": [16.0, 3.0],
        }
    )

    result = calculate_ruminant_legume_swap_scenarios(df, region="us")

    assert result.empty
    assert "scenario" in result.columns


def test_calculate_ruminant_legume_swap_scenarios_raises_for_missing_source_emission_factors():
    """A missing factor for a source category should fail loudly instead of fabricating a
    scenario."""
    df = pd.DataFrame(
        {
            "category": ["Beef and Buffalo Meat"],
            "kilos_total": [10.0],
            "emissions_kg_co2e": [413.5],
        }
    )

    def fake_emission_factor(category: str, region: str = "us"):
        if category == "Legumes":
            return 1.6
        if category == "Beef and Buffalo Meat":
            return None
        return 1.0

    with (
        patch(
            "gbd_foodservice_insights.report.aggregation.get_emission_factor",
            side_effect=fake_emission_factor,
        ),
        pytest.raises(ValueError, match="Missing ruminant emission factors"),
    ):
        calculate_ruminant_legume_swap_scenarios(df, region="us")


def test_calculate_milk_oat_swap_scenarios_avoids_divide_by_zero_when_total_emissions_zero():
    """Swap tables should avoid divide-by-zero when the institution emissions column sums to
    zero."""
    df = pd.DataFrame(
        {
            "category": ["Milk (Cow's milk)"],
            "kilos_total": [20.0],
            "emissions_kg_co2e": [0.0],
        }
    )

    result = calculate_milk_oat_swap_scenarios(df, region="us")

    assert not result.empty
    assert result["institution_emissions_avoided_pct"].tolist() == [0.0, 0.0, 0.0, 0.0]
