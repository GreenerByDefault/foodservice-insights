from unittest.mock import patch

import pandas as pd
import pytest
from gbd_foodservice_insights.categories import category_names
from gbd_foodservice_insights.report import aggregation
from gbd_foodservice_insights.report.aggregation import (
    AnimalEmissionsConcentration,
    ProcurementAggregation,
    _attach_monthly_category_emissions,
    aggregate_data,
    calculate_animal_emissions_concentration,
    calculate_milk_oat_swap_scenarios,
    calculate_plant_animal_split,
    calculate_plant_protein_share,
    calculate_ruminant_legume_swap_scenarios,
    create_template_data,
    identify_category_drivers,
    identify_overall_drivers,
    run_aggregation_pipeline,
    summarize_animal_emissions_intensity,
)

JAN, FEB = pd.period_range("2024-01", periods=2, freq="M")

# ----------------------------------------------------------------------
# Aggregation and drivers
# ----------------------------------------------------------------------


@pytest.fixture
def fruit_rows():
    return pd.DataFrame(
        {
            "date": pd.to_datetime(["2023-01-01", "2023-01-15", "2023-02-01"]),
            "product": ["apple", "banana", "apple"],
            "kilos_total": [10, 20, 15],
            "category": ["fruit", "fruit", "fruit"],
            "month_year": ["2023-01", "2023-01", "2023-02"],
        }
    )


def test_aggregate_data_sums_by_month_and_group(fruit_rows):
    assert aggregate_data(fruit_rows, group_by="product").to_dict("records") == [
        {"month_year": "2023-01", "product": "apple", "kilos_total": 10},
        {"month_year": "2023-01", "product": "banana", "kilos_total": 20},
        {"month_year": "2023-02", "product": "apple", "kilos_total": 15},
    ]


def test_aggregate_data_keeps_rows_with_missing_group_keys():
    df = pd.DataFrame(
        {
            "month_year": [JAN, JAN],
            "category": ["legumes", pd.NA],
            "kilos_total": [10.0, 5.0],
        }
    )

    out = aggregate_data(df, group_by="category", metrics=["kilos_total"])

    pd.testing.assert_frame_equal(
        out,
        pd.DataFrame(
            {"month_year": [JAN, JAN], "category": ["legumes", pd.NA], "kilos_total": [10.0, 5.0]}
        ),
    )


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"group_by": "region"}, "group_by must be 'product' or 'category'"),
        ({"group_by": "category", "metrics": "kilos_total"}, "'category' column not found"),
        ({"metrics": []}, "at least one metric"),
        ({"metrics": ["kilos_total", "servings total"]}, "Metric column 'servings total'"),
    ],
)
def test_aggregate_data_rejects_bad_arguments(fruit_rows, kwargs, message):
    rows = (
        fruit_rows.drop(columns="category") if kwargs.get("group_by") == "category" else fruit_rows
    )
    with pytest.raises(ValueError, match=message):
        aggregate_data(rows, **kwargs)


def test_aggregate_data_requires_month_year(fruit_rows):
    with pytest.raises(ValueError, match="'month_year' column not found"):
        aggregate_data(fruit_rows.drop(columns="month_year"))


def test_create_template_data_requires_the_metric_column():
    with pytest.raises(KeyError):
        create_template_data(pd.DataFrame({"month_year": [], "category": []}), "kilos_total")


def test_create_template_data_places_each_value_under_its_category():
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


@patch("gbd_foodservice_insights.report.aggregation.category_names")
def test_create_template_data_zero_fills_absent_categories(mock_get_gbd_categories, fruit_rows):
    """Report templates include every category so chart tables keep a stable shape."""
    mock_get_gbd_categories.return_value = ["fruit", "vegetable"]
    agg_df = aggregate_data(fruit_rows, group_by="category")
    template_df = create_template_data(agg_df, metric="kilos_total")
    assert "total" in template_df.columns
    assert "fruit" in template_df.index
    assert "vegetable" in template_df.index
    assert template_df.loc["vegetable", "total"] == 0


def test_identify_category_drivers_ranks_products_within_each_category(fruit_rows):
    drivers_df = identify_category_drivers(fruit_rows, metric="kilos_total", top_n=1)

    assert drivers_df.to_dict("records") == [
        {
            "category": "fruit",
            "product": "apple",
            "kilos_total": 25,
            "kilos_total_in_category": 45,
            "percentage": 55.6,
        }
    ]


def test_identify_overall_drivers_ranks_products_across_categories(fruit_rows):
    drivers_df = identify_overall_drivers(fruit_rows, metric="kilos_total", top_n=1)

    assert drivers_df.to_dict("records") == [
        {"product": "apple", "kilos_total": 25, "percentage": 55.6}
    ]


@pytest.mark.parametrize("identify", [identify_category_drivers, identify_overall_drivers])
def test_identify_drivers_requires_the_metric_column(fruit_rows, identify):
    with pytest.raises(ValueError, match="Metric column 'servings total' not found"):
        identify(fruit_rows, metric="servings total")


@pytest.mark.parametrize("identify", [identify_category_drivers, identify_overall_drivers])
def test_identify_drivers_report_zero_percent_when_the_total_is_zero(identify):
    zero_rows = pd.DataFrame({"category": ["fruit"], "product": ["apple"], "kilos_total": [0.0]})

    assert identify(zero_rows)["percentage"].tolist() == [0.0]


# ----------------------------------------------------------------------
# Plant and protein shares
# ----------------------------------------------------------------------


def test_calculate_plant_animal_split_keeps_one_sided_months():
    """Plant-vs-animal summaries should keep months where one side is absent instead of dropping
    them."""
    df = pd.DataFrame(
        {
            "month_year": ["2024-01", "2024-02", "2024-02"],
            "category": ["Legumes", "Beef", "Other"],
            "kilos_total": [4.0, 3.0, 99.0],
        }
    )

    with (
        patch(
            "gbd_foodservice_insights.report.aggregation.animal_product_categories",
            return_value=["Beef"],
        ),
        patch(
            "gbd_foodservice_insights.report.aggregation.plant_based_categories",
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
            "gbd_foodservice_insights.report.aggregation.animal_product_categories",
            return_value=["Beef"],
        ),
        patch(
            "gbd_foodservice_insights.report.aggregation.plant_based_categories",
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
            "category": ["Legumes", "Beef", "Vegetables"],
            "kilos_total": [4.0, 6.0, 100.0],
        }
    )

    with (
        patch(
            "gbd_foodservice_insights.report.aggregation.protein_categories",
            return_value=["Legumes", "Beef"],
        ),
        patch(
            "gbd_foodservice_insights.report.aggregation.plant_protein_categories",
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
            "gbd_foodservice_insights.report.aggregation.protein_categories",
            return_value=["Legumes", "Beef"],
        ),
        patch(
            "gbd_foodservice_insights.report.aggregation.plant_protein_categories",
            return_value=["Legumes"],
        ),
    ):
        result = calculate_plant_protein_share(df)

    assert result is None


@pytest.mark.parametrize("calculate", [calculate_plant_animal_split, calculate_plant_protein_share])
@pytest.mark.parametrize("missing", ["kilos_total", "category"])
def test_plant_shares_are_none_when_a_required_column_is_missing(calculate, missing):
    df = pd.DataFrame({"category": ["Legumes"], "kilos_total": [1.0]}).drop(columns=missing)

    assert calculate(df) is None


def test_plant_shares_have_no_monthly_table_without_month_year():
    df = pd.DataFrame({"category": ["Legumes", "Beef"], "kilos_total": [1.0, 1.0]})

    with (
        patch(
            "gbd_foodservice_insights.report.aggregation.animal_product_categories",
            return_value=["Beef"],
        ),
        patch(
            "gbd_foodservice_insights.report.aggregation.plant_based_categories",
            return_value=["Legumes"],
        ),
        patch(
            "gbd_foodservice_insights.report.aggregation.protein_categories",
            return_value=["Legumes", "Beef"],
        ),
        patch(
            "gbd_foodservice_insights.report.aggregation.plant_protein_categories",
            return_value=["Legumes"],
        ),
    ):
        split = calculate_plant_animal_split(df)
        protein = calculate_plant_protein_share(df)

    assert split is not None and split["monthly"] is None
    assert protein is not None and protein["monthly"] is None


# ----------------------------------------------------------------------
# Animal emissions
# ----------------------------------------------------------------------


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
        "gbd_foodservice_insights.report.aggregation.animal_product_categories",
        return_value=["Beef", "Cheese"],
    ):
        result = calculate_animal_emissions_concentration(df, top_n=1)

    assert result == AnimalEmissionsConcentration(
        top_products=("burger",), top_products_kg_co2e=8.0, total_animal_kg_co2e=10.0
    )
    assert result.share_pct == pytest.approx(80.0)


def test_calculate_animal_emissions_concentration_ranks_every_product_when_top_n_too_large():
    df = pd.DataFrame(
        {
            "product": ["burger", "cheddar"],
            "category": ["Beef", "Cheese"],
            "emissions_kg_co2e": [8.0, 2.0],
        }
    )

    with patch(
        "gbd_foodservice_insights.report.aggregation.animal_product_categories",
        return_value=["Beef", "Cheese"],
    ):
        result = calculate_animal_emissions_concentration(df, top_n=5)

    assert result == AnimalEmissionsConcentration(
        top_products=("burger", "cheddar"), top_products_kg_co2e=10.0, total_animal_kg_co2e=10.0
    )


def test_calculate_animal_emissions_concentration_is_none_when_animal_emissions_total_zero():
    """Zero animal emissions should not produce a misleading concentration KPI."""
    df = pd.DataFrame(
        {
            "product": ["burger", "cheddar"],
            "category": ["Beef", "Cheese"],
            "emissions_kg_co2e": [0.0, 0.0],
        }
    )

    with patch(
        "gbd_foodservice_insights.report.aggregation.animal_product_categories",
        return_value=["Beef", "Cheese"],
    ):
        result = calculate_animal_emissions_concentration(df, top_n=2)

    assert result is None


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
        "gbd_foodservice_insights.report.aggregation.animal_product_categories",
        return_value=["Beef", "Cheese"],
    ):
        result = calculate_animal_emissions_concentration(df, top_n=2)

    assert result is not None
    assert result.top_products == ("Missing product name", "cheddar")


def test_summarize_animal_emissions_intensity_covers_only_animal_categories():
    df = pd.DataFrame(
        {
            "category": [
                "Beef and Buffalo Meat",
                "Beef and Buffalo Meat",
                "Poultry (Chicken & Turkey)",
                "Legumes",
            ],
            "kilos_total": [2.0, 3.0, 4.0, 5.0],
            "emissions_kg_co2e": [82.7, 124.05, 17.6, 8.0],
        }
    )

    summary = summarize_animal_emissions_intensity(df)

    assert summary["category"].tolist() == [
        "Beef and Buffalo Meat",
        "Poultry (Chicken & Turkey)",
    ]
    assert summary["kilos_total"].tolist() == [5.0, 4.0]
    assert summary["total_kg_co2e"].tolist() == [206.75, 17.6]
    assert summary["kg_co2e_per_kg_food"].tolist() == [41.35, 4.4]


def test_summarize_animal_emissions_intensity_is_empty_without_the_required_columns():
    df = pd.DataFrame({"category": ["Beef and Buffalo Meat"], "kilos_total": [1.0]})

    summary = summarize_animal_emissions_intensity(df)

    assert summary.empty
    assert list(summary.columns) == [
        "category",
        "kilos_total",
        "total_kg_co2e",
        "kg_co2e_per_kg_food",
    ]


def test_summarize_animal_emissions_intensity_is_empty_without_animal_rows():
    df = pd.DataFrame({"category": ["Legumes"], "kilos_total": [1.0], "emissions_kg_co2e": [1.0]})

    assert summarize_animal_emissions_intensity(df).empty


def test_summarize_animal_emissions_intensity_leaves_a_zero_weight_category_without_intensity():
    df = pd.DataFrame(
        {
            "category": ["Beef and Buffalo Meat"],
            "kilos_total": [0.0],
            "emissions_kg_co2e": [0.0],
        }
    )

    assert summarize_animal_emissions_intensity(df)["kg_co2e_per_kg_food"].isna().tolist() == [True]


def test_calculate_animal_emissions_concentration_is_none_without_the_required_columns():
    df = pd.DataFrame({"product": ["burger"], "category": ["Beef"]})

    assert calculate_animal_emissions_concentration(df) is None


# ----------------------------------------------------------------------
# Substitution scenarios
# ----------------------------------------------------------------------


# Categories compare exactly, so a misspelled name here would silently match no rows.
@pytest.mark.parametrize(
    "name",
    [
        *aggregation._RUMINANT_SWAP_SOURCE_CATEGORIES,
        aggregation._RUMINANT_SWAP_TARGET_CATEGORY,
        *aggregation._MILK_SWAP_SOURCE_CATEGORIES,
        aggregation._MILK_SWAP_TARGET_CATEGORY,
    ],
)
def test_swap_categories_are_gbd_names(name: str):
    assert name in category_names()


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
    assert result["baseline_source_weight_kg"].tolist() == [15.0, 15.0, 15.0, 15.0]
    assert result["baseline_source_emissions_kg_co2e"].tolist() == [621.6] * 4
    assert result.loc[0, "replaced_weight_kg"] == pytest.approx(1.5)
    assert result.loc[0, "avoidable_kg_co2e"] == pytest.approx(59.76)
    assert result.loc[0, "projected_emissions_kg_co2e"] == pytest.approx(561.84)
    assert result.loc[0, "institution_emissions_avoided_pct"] == pytest.approx(9.42)
    assert result.loc[3, "projected_emissions_kg_co2e"] == pytest.approx(24.0)
    assert result.loc[3, "replacement_category"] == "Legumes"


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


def test_calculate_category_swap_scenarios_is_empty_without_the_weight_or_category_column():
    df = pd.DataFrame({"category": ["Beef and Buffalo Meat"], "emissions_kg_co2e": [1.0]})

    assert calculate_ruminant_legume_swap_scenarios(df).empty


def test_calculate_category_swap_scenarios_is_empty_when_the_source_weighs_nothing():
    df = pd.DataFrame(
        {
            "category": ["Beef and Buffalo Meat"],
            "kilos_total": [0.0],
            "emissions_kg_co2e": [0.0],
        }
    )

    assert calculate_ruminant_legume_swap_scenarios(df, region="us").empty


def test_calculate_category_swap_scenarios_raises_for_a_missing_replacement_factor():
    df = pd.DataFrame(
        {
            "category": ["Beef and Buffalo Meat"],
            "kilos_total": [10.0],
            "emissions_kg_co2e": [413.5],
        }
    )

    with (
        patch("gbd_foodservice_insights.report.aggregation.get_emission_factor", return_value=None),
        pytest.raises(ValueError, match="No emission factor found for 'Legumes'"),
    ):
        calculate_ruminant_legume_swap_scenarios(df, region="us")


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
    assert result["baseline_source_emissions_kg_co2e"].tolist() == [43.4] * 4
    assert result.loc[0, "avoidable_kg_co2e"] == pytest.approx(2.56)
    assert result.loc[0, "institution_emissions_avoided_pct"] == pytest.approx(4.28)
    assert result.loc[3, "projected_emissions_kg_co2e"] == pytest.approx(17.8)


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


def test_run_aggregation_pipeline_returns_substitution_scenarios_for_procurement():
    """Ensures procurement aggregation payloads carry the substitution sheet to Excel writers."""
    df = pd.DataFrame(
        {
            "month_year": [JAN, FEB, FEB],
            "category": ["Beef and Buffalo Meat", "Lamb/mutton & goat meat", "Milk (Cow's milk)"],
            "product": ["beef mince", "lamb shoulder", "whole milk"],
            "kilos_total": [10.0, 5.0, 20.0],
            "emissions_kg_co2e": [413.5, 208.1, 65.6],
        }
    )

    result = run_aggregation_pipeline(
        df,
        diner_meal_mapping={JAN: 100.0, FEB: 120.0},
        mode="procurement",
        region="us",
        diner_or_meal="diner",
    )

    assert result.procurement is not None
    assert result.procurement.substitution_scenarios is not None
    assert result.procurement.substitution_scenarios["scenario"].tolist() == [
        "10% ruminant-to-legume swap",
        "25% ruminant-to-legume swap",
        "50% ruminant-to-legume swap",
        "100% ruminant-to-legume swap",
        "10% cow's-milk-to-oat-milk swap",
        "20% cow's-milk-to-oat-milk swap",
        "50% cow's-milk-to-oat-milk swap",
        "100% cow's-milk-to-oat-milk swap",
    ]


def test_run_aggregation_pipeline_monthly_tables_each_sum_to_the_input_total():
    # A product in two categories, one bought in two months, and a 0 kg line: each is a way for
    # a grouping to drop or double-count weight.
    df = pd.DataFrame(
        {
            "month_year": [JAN, JAN, FEB, FEB, FEB],
            "category": ["Legumes", "Nuts & Seeds", "Legumes", "Beef and Buffalo Meat", "Legumes"],
            "product": ["beans", "beans", "beans", "beef mince", "lentils"],
            "kilos_total": [4.0, 2.5, 6.0, 10.0, 0.0],
            "emissions_kg_co2e": [3.6, 1.0, 5.4, 413.5, 0.0],
        }
    )

    result = run_aggregation_pipeline(
        df,
        diner_meal_mapping={JAN: 100.0, FEB: 120.0},
        mode="procurement",
        region="us",
        diner_or_meal="diner",
    )

    assert result.monthly_product["kilos_total"].sum() == 22.5
    assert result.monthly_category["kilos_total"].sum() == 22.5


@pytest.mark.parametrize("diner_or_meal", ["diner", "meal"])
def test_run_aggregation_pipeline_divides_each_month_by_its_count(diner_or_meal):
    df = pd.DataFrame(
        {
            "month_year": [JAN, JAN, FEB],
            "category": ["Legumes", "Legumes", "Legumes"],
            "product": ["beans", "lentils", "beans"],
            "kilos_total": [10.0, 20.0, 15.0],
            "emissions_kg_co2e": [9.0, 18.0, 13.5],
        }
    )

    result = run_aggregation_pipeline(
        df,
        diner_meal_mapping={JAN: 100.0, FEB: 120.0},
        mode="procurement",
        diner_or_meal=diner_or_meal,
    )

    per_head = f"kilos per {diner_or_meal}"
    assert result.monthly_product[per_head].tolist() == pytest.approx([0.1, 0.2, 0.125])
    assert result.monthly_category[per_head].tolist() == pytest.approx([0.3, 0.125])


def test_run_aggregation_pipeline_leaves_out_procurement_tables_with_nothing_to_show():
    df = pd.DataFrame(
        {
            "month_year": [JAN],
            "category": ["Legumes"],
            "product": ["beans"],
            "kilos_total": [4.0],
            "emissions_kg_co2e": [3.6],
        }
    )

    result = run_aggregation_pipeline(
        df,
        diner_meal_mapping={JAN: 100.0},
        mode="procurement",
        diner_or_meal="diner",
    )

    assert result.procurement == ProcurementAggregation(
        animal_emissions_intensity=None,
        animal_emissions_concentration=None,
        substitution_scenarios=None,
    )


def test_run_aggregation_pipeline_serving_has_no_procurement_aggregation_or_emissions():
    df = pd.DataFrame(
        {
            "month_year": [JAN, JAN],
            "category": ["Beef and Buffalo Meat", "Milk (Cow's milk)"],
            "product": ["beef mince", "whole milk"],
            "servings total": [10.0, 20.0],
        }
    )

    result = run_aggregation_pipeline(
        df,
        diner_meal_mapping={JAN: 100.0},
        mode="serving",
        diner_or_meal="meal",
    )

    assert list(result.monthly_category.columns) == [
        "month_year",
        "category",
        "servings total",
        "servings per meal",
    ]
    assert result.procurement is None


def test_attach_monthly_category_emissions_keeps_each_category_share():
    raw = pd.DataFrame(
        {
            "month_year": [JAN, JAN, JAN, JAN, FEB],
            "category": ["beef", "beef", "legumes", None, "beef"],
            "emissions_kg_co2e": [30.0, 10.0, 2.0, 1.0, 50.0],
        }
    )
    monthly_cat = pd.DataFrame(
        {
            "month_year": [JAN, JAN, JAN, FEB],
            "category": ["beef", "legumes", None, "beef"],
            "kilos_total": [4.0, 3.0, 1.0, 5.0],
        }
    )

    out = _attach_monthly_category_emissions(monthly_cat, raw)

    pd.testing.assert_frame_equal(
        out,
        monthly_cat.assign(emissions_kg_co2e=[40.0, 2.0, 1.0, 50.0]),
    )
