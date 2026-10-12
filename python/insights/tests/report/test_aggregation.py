from typing import Any

import pandas as pd
import pytest
from gbd_foodservice_insights.categories import category_names
from gbd_foodservice_insights.report import aggregation
from gbd_foodservice_insights.report.aggregation import (
    AnimalEmissionsConcentration,
    PlantAnimalSplit,
    PlantProteinShare,
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
    assert aggregate_data(fruit_rows, "product", "kilos_total").to_dict("records") == [
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

    out = aggregate_data(df, "category", "kilos_total")

    pd.testing.assert_frame_equal(
        out,
        pd.DataFrame(
            {"month_year": [JAN, JAN], "category": ["legumes", pd.NA], "kilos_total": [10.0, 5.0]}
        ),
    )


def test_aggregate_data_leaves_an_all_missing_group_missing_rather_than_zero():
    df = pd.DataFrame(
        {
            "month_year": [JAN, JAN, FEB],
            "product": ["apple", "apple", "apple"],
            "kilos_total": [None, None, 3.0],
        }
    )

    out = aggregate_data(df, "product", "kilos_total")

    assert out["kilos_total"].isna().tolist() == [True, False]


@pytest.fixture
def three_categories(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        aggregation, "category_names", lambda: ["Cheese", "Legumes", "Milk (Cow's milk)"]
    )


@pytest.mark.usefixtures("three_categories")
def test_create_template_data_pivots_months_into_columns_with_totals_and_zero_filled_categories():
    monthly_category_data = pd.DataFrame(
        {
            "month_year": ["2024-01", "2024-01", "2024-01", "2024-02"],
            "category": ["Legumes", "Cheese", "Legumes", "Legumes"],
            "kilos_total": [12.1234, 8.0, 1.0, 30.0],
        }
    )

    template = create_template_data(monthly_category_data, "kilos_total")

    # Cheese has no February line, so its cell is blank; Milk has none at all, so its row is 0.
    expected = pd.DataFrame(
        {
            "2024-01": [8.0, 13.123, 0.0, 21.123],
            "2024-02": [float("nan"), 30.0, 0.0, 30.0],
            "total": [8.0, 43.123, 0.0, 51.123],
        },
        index=pd.Index(["Cheese", "Legumes", "Milk (Cow's milk)", "total"], name="category"),
    )
    expected.columns.name = "month_year"
    pd.testing.assert_frame_equal(template, expected)


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


def test_identify_category_drivers_ranks_the_top_products_within_each_category():
    rows = pd.DataFrame(
        {
            "category": ["A", "A", "A", "B", "B", "B"],
            "product": ["x", "y", "z", "u", "v", "w"],
            "kilos_total": [1.0, 5.0, 3.0, 2.0, 2.0, 7.0],
        }
    )

    drivers_df = identify_category_drivers(rows, metric="kilos_total", top_n=2)

    assert drivers_df.to_dict("records") == [
        {
            "category": "A",
            "product": "y",
            "kilos_total": 5.0,
            "kilos_total_in_category": 9.0,
            "percentage": 55.6,
        },
        {
            "category": "A",
            "product": "z",
            "kilos_total": 3.0,
            "kilos_total_in_category": 9.0,
            "percentage": 33.3,
        },
        {
            "category": "B",
            "product": "w",
            "kilos_total": 7.0,
            "kilos_total_in_category": 11.0,
            "percentage": 63.6,
        },
        {
            "category": "B",
            "product": "u",
            "kilos_total": 2.0,
            "kilos_total_in_category": 11.0,
            "percentage": 18.2,
        },
    ]


def test_identify_category_drivers_sums_a_products_lines_across_months():
    rows = pd.DataFrame(
        {
            "category": ["A", "A", "A"],
            "product": ["x", "x", "y"],
            "kilos_total": [2.0, 3.0, 4.0],
        }
    )

    drivers_df = identify_category_drivers(rows, top_n=5)

    assert drivers_df[["product", "kilos_total"]].to_dict("records") == [
        {"product": "x", "kilos_total": 5.0},
        {"product": "y", "kilos_total": 4.0},
    ]


def test_identify_overall_drivers_sums_a_product_across_categories_and_ranks_the_top_n():
    rows = pd.DataFrame(
        {
            "category": ["A", "A", "A", "B", "B", "B"],
            "product": ["x", "y", "z", "u", "v", "x"],
            "kilos_total": [1.0, 5.0, 3.0, 2.0, 2.0, 7.0],
        }
    )

    drivers_df = identify_overall_drivers(rows, metric="kilos_total", top_n=2)

    assert drivers_df.to_dict("records") == [
        {"product": "x", "kilos_total": 8.0, "percentage": 40.0},
        {"product": "y", "kilos_total": 5.0, "percentage": 25.0},
    ]


def test_identify_drivers_report_zero_percent_when_the_total_is_zero():
    zero_rows = pd.DataFrame({"category": ["fruit"], "product": ["apple"], "kilos_total": [0.0]})

    assert identify_category_drivers(zero_rows).to_dict("records") == [
        {
            "category": "fruit",
            "product": "apple",
            "kilos_total": 0.0,
            "kilos_total_in_category": 0.0,
            "percentage": 0.0,
        }
    ]
    assert identify_overall_drivers(zero_rows).to_dict("records") == [
        {"product": "apple", "kilos_total": 0.0, "percentage": 0.0}
    ]


# ----------------------------------------------------------------------
# Plant and protein shares
# ----------------------------------------------------------------------


@pytest.fixture
def plant_and_animal_categories(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(aggregation, "animal_product_categories", lambda: ["Beef"])
    monkeypatch.setattr(aggregation, "protein_categories", lambda: ["Legumes", "Beef"])
    monkeypatch.setattr(aggregation, "plant_protein_categories", lambda: ["Legumes"])


def _without_monthly(share: PlantAnimalSplit | PlantProteinShare) -> dict[str, Any]:
    return {name: value for name, value in vars(share).items() if name != "monthly"}


@pytest.mark.usefixtures("plant_and_animal_categories")
def test_calculate_plant_animal_split_counts_every_non_animal_row_as_plant():
    df = pd.DataFrame(
        {
            "month_year": ["2024-01", "2024-02", "2024-02"],
            "category": ["Legumes", "Beef", "Vegetables"],
            "kilos_total": [4.0, 3.0, 1.0],
        }
    )

    result = calculate_plant_animal_split(df)

    assert _without_monthly(result) == {
        "plant_pct": 62.5,
        "animal_pct": 37.5,
        "plant_total": 5.0,
        "animal_total": 3.0,
    }
    pd.testing.assert_frame_equal(
        result.monthly,
        pd.DataFrame(
            {
                "month_year": ["2024-01", "2024-02"],
                "plant": [4.0, 1.0],
                "animal": [0.0, 3.0],
                "plant_pct": [100.0, 25.0],
            }
        ),
    )


@pytest.mark.usefixtures("plant_and_animal_categories")
def test_calculate_plant_animal_split_adds_the_missing_side_to_the_monthly_table():
    df = pd.DataFrame(
        {
            "month_year": ["2024-01", "2024-02"],
            "category": ["Legumes"] * 2,
            "kilos_total": [3.0, 1.0],
        }
    )

    result = calculate_plant_animal_split(df)

    assert _without_monthly(result) == {
        "plant_pct": 100.0,
        "animal_pct": 0.0,
        "plant_total": 4.0,
        "animal_total": 0.0,
    }
    pd.testing.assert_frame_equal(
        result.monthly,
        pd.DataFrame(
            {
                "month_year": ["2024-01", "2024-02"],
                "plant": [3.0, 1.0],
                "animal": [0.0, 0.0],
                "plant_pct": [100.0, 100.0],
            }
        ),
    )


@pytest.mark.usefixtures("plant_and_animal_categories")
def test_calculate_plant_animal_split_gives_a_zero_month_no_percentage():
    df = pd.DataFrame(
        {
            "month_year": ["2024-01", "2024-01", "2024-02", "2024-02"],
            "category": ["Legumes", "Beef"] * 2,
            "kilos_total": [3.0, 1.0, 0.0, 0.0],
        }
    )

    result = calculate_plant_animal_split(df)

    assert result.monthly["plant_pct"].isna().tolist() == [False, True]


@pytest.mark.usefixtures("plant_and_animal_categories")
def test_calculate_plant_animal_split_rejects_a_zero_total():
    df = pd.DataFrame(
        {"month_year": ["2024-01"] * 2, "category": ["Legumes", "Beef"], "kilos_total": [0.0, 0.0]}
    )

    with pytest.raises(ValueError, match="nothing to split"):
        calculate_plant_animal_split(df)


@pytest.mark.usefixtures("plant_and_animal_categories")
def test_calculate_plant_protein_share_ignores_non_protein_rows_and_keeps_months():
    df = pd.DataFrame(
        {
            "month_year": ["2024-01", "2024-02", "2024-02"],
            "category": ["Legumes", "Beef", "Vegetables"],
            "kilos_total": [4.0, 6.0, 100.0],
        }
    )

    result = calculate_plant_protein_share(df)

    assert result is not None
    assert _without_monthly(result) == {
        "plant_protein_pct": 40.0,
        "plant_protein_total": 4.0,
        "protein_total": 10.0,
    }
    pd.testing.assert_frame_equal(
        result.monthly,
        pd.DataFrame(
            {
                "month_year": ["2024-01", "2024-02"],
                "plant_protein_metric": [4.0, 0.0],
                "total_protein_metric": [4.0, 6.0],
                "plant_protein_pct": [100.0, 0.0],
            }
        ),
    )


@pytest.mark.usefixtures("plant_and_animal_categories")
def test_calculate_plant_protein_share_is_zero_percent_when_all_protein_is_animal():
    df = pd.DataFrame(
        {"month_year": ["2024-01", "2024-02"], "category": ["Beef"] * 2, "kilos_total": [3.0, 1.0]}
    )

    result = calculate_plant_protein_share(df)

    assert result is not None
    assert _without_monthly(result) == {
        "plant_protein_pct": 0.0,
        "plant_protein_total": 0.0,
        "protein_total": 4.0,
    }
    pd.testing.assert_frame_equal(
        result.monthly,
        pd.DataFrame(
            {
                "month_year": ["2024-01", "2024-02"],
                "plant_protein_metric": [0.0, 0.0],
                "total_protein_metric": [3.0, 1.0],
                "plant_protein_pct": [0.0, 0.0],
            }
        ),
    )


@pytest.mark.usefixtures("plant_and_animal_categories")
def test_calculate_plant_protein_share_is_100_percent_when_all_protein_is_plant():
    df = pd.DataFrame(
        {
            "month_year": ["2024-01", "2024-02"],
            "category": ["Legumes"] * 2,
            "kilos_total": [3.0, 1.0],
        }
    )

    result = calculate_plant_protein_share(df)

    assert result is not None
    assert _without_monthly(result) == {
        "plant_protein_pct": 100.0,
        "plant_protein_total": 4.0,
        "protein_total": 4.0,
    }
    pd.testing.assert_frame_equal(
        result.monthly,
        pd.DataFrame(
            {
                "month_year": ["2024-01", "2024-02"],
                "plant_protein_metric": [3.0, 1.0],
                "total_protein_metric": [3.0, 1.0],
                "plant_protein_pct": [100.0, 100.0],
            }
        ),
    )


@pytest.mark.usefixtures("plant_and_animal_categories")
def test_calculate_plant_protein_share_gives_a_zero_month_no_percentage():
    df = pd.DataFrame(
        {
            "month_year": ["2024-01", "2024-01", "2024-02", "2024-02"],
            "category": ["Legumes", "Beef"] * 2,
            "kilos_total": [3.0, 0.0, 0.0, 0.0],
        }
    )

    result = calculate_plant_protein_share(df)

    assert result is not None
    assert result.monthly["plant_protein_pct"].isna().tolist() == [False, True]


@pytest.mark.usefixtures("plant_and_animal_categories")
@pytest.mark.parametrize(
    ("categories", "kilos"),
    [
        pytest.param(["Vegetables"], [5.0], id="no-protein-rows"),
        pytest.param(["Legumes", "Beef"], [0.0, 0.0], id="zero-protein"),
    ],
)
def test_calculate_plant_protein_share_returns_none_without_protein_volume(categories, kilos):
    df = pd.DataFrame(
        {"month_year": ["2024-01"] * len(kilos), "category": categories, "kilos_total": kilos}
    )

    assert calculate_plant_protein_share(df) is None


# ----------------------------------------------------------------------
# Animal emissions
# ----------------------------------------------------------------------


@pytest.fixture
def beef_and_cheese(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(aggregation, "animal_product_categories", lambda: ["Beef", "Cheese"])


@pytest.mark.usefixtures("beef_and_cheese")
def test_calculate_animal_emissions_concentration_only_uses_animal_rows():
    df = pd.DataFrame(
        {
            "product": ["burger", "cheddar", "lentils"],
            "category": ["Beef", "Cheese", "Legumes"],
            "emissions_kg_co2e": [8.0, 2.0, 100.0],
        }
    )

    result = calculate_animal_emissions_concentration(df, top_n=1)

    assert result == AnimalEmissionsConcentration(
        top_products=("burger",), top_products_kg_co2e=8.0, total_animal_kg_co2e=10.0
    )
    assert result.share_pct == 80.0


@pytest.mark.usefixtures("beef_and_cheese")
def test_calculate_animal_emissions_concentration_sums_a_product_across_lines_and_ranks_it():
    df = pd.DataFrame(
        {
            "product": ["cheddar", "burger", "cheddar", "brie"],
            "category": ["Cheese", "Beef", "Cheese", "Cheese"],
            "emissions_kg_co2e": [4.0, 6.0, 4.0, 1.0],
        }
    )

    result = calculate_animal_emissions_concentration(df, top_n=5)

    assert result == AnimalEmissionsConcentration(
        top_products=("cheddar", "burger", "brie"),
        top_products_kg_co2e=15.0,
        total_animal_kg_co2e=15.0,
    )


@pytest.mark.usefixtures("beef_and_cheese")
@pytest.mark.parametrize("emissions", [[0.0, 0.0], [None, None]], ids=["zero", "all-missing"])
def test_calculate_animal_emissions_concentration_is_none_without_animal_emissions(emissions):
    df = pd.DataFrame(
        {
            "product": ["burger", "cheddar"],
            "category": ["Beef", "Cheese"],
            "emissions_kg_co2e": emissions,
        }
    )

    assert calculate_animal_emissions_concentration(df, top_n=2) is None


@pytest.mark.usefixtures("beef_and_cheese")
def test_calculate_animal_emissions_concentration_is_none_without_animal_rows():
    df = pd.DataFrame({"product": ["a"], "category": ["Legumes"], "emissions_kg_co2e": [5.0]})

    assert calculate_animal_emissions_concentration(df, top_n=5) is None


@pytest.mark.usefixtures("beef_and_cheese")
def test_calculate_animal_emissions_concentration_uses_missing_product_name_fallback():
    df = pd.DataFrame(
        {
            "product": [pd.NA, "cheddar"],
            "category": ["Beef", "Cheese"],
            "emissions_kg_co2e": [5.0, 3.0],
        }
    )

    result = calculate_animal_emissions_concentration(df, top_n=2)

    assert result == AnimalEmissionsConcentration(
        top_products=("Missing product name", "cheddar"),
        top_products_kg_co2e=8.0,
        total_animal_kg_co2e=8.0,
    )


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

    pd.testing.assert_frame_equal(
        summary,
        pd.DataFrame(
            {
                "category": ["Beef and Buffalo Meat", "Poultry (Chicken & Turkey)"],
                "kilos_total": [5.0, 4.0],
                "total_kg_co2e": [206.75, 17.6],
                "kg_co2e_per_kg_food": [41.35, 4.4],
            }
        ),
    )


def test_summarize_animal_emissions_intensity_is_an_empty_table_without_animal_rows():
    df = pd.DataFrame({"category": ["Legumes"], "kilos_total": [1.0], "emissions_kg_co2e": [1.0]})

    summary = summarize_animal_emissions_intensity(df)

    assert summary.empty
    assert list(summary.columns) == [
        "category",
        "kilos_total",
        "total_kg_co2e",
        "kg_co2e_per_kg_food",
    ]


def test_summarize_animal_emissions_intensity_leaves_a_zero_weight_category_without_intensity():
    df = pd.DataFrame(
        {
            "category": ["Beef and Buffalo Meat", "Poultry (Chicken & Turkey)"],
            "kilos_total": [0.0, 2.0],
            "emissions_kg_co2e": [0.0, 8.0],
        }
    )

    summary = summarize_animal_emissions_intensity(df)

    assert summary["category"].tolist() == ["Poultry (Chicken & Turkey)", "Beef and Buffalo Meat"]
    assert summary["kg_co2e_per_kg_food"].tolist()[0] == 4.0
    assert summary["kg_co2e_per_kg_food"].isna().tolist() == [False, True]


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


_SWAP_COLUMNS = [
    "scenario",
    "substitution_pct",
    "source_categories",
    "replacement_category",
    "baseline_source_weight_kg",
    "baseline_source_emissions_kg_co2e",
    "replaced_weight_kg",
    "remaining_source_weight_kg",
    "replacement_weight_kg",
    "replacement_emission_factor_kg_co2e_per_kg",
    "projected_emissions_kg_co2e",
    "avoidable_kg_co2e",
    "institution_emissions_avoided_pct",
]

_RUMINANT_ROWS = pd.DataFrame(
    {
        "month_year": ["2024-01", "2024-01", "2024-02"],
        "category": ["Beef and Buffalo Meat", "Lamb/mutton & goat meat", "Legumes"],
        "product": ["beef mince", "lamb shoulder", "lentils"],
        "kilos_total": [10.0, 5.0, 8.0],
        "emissions_kg_co2e": [413.5, 208.1, 12.8],
    }
)


def test_calculate_ruminant_legume_swap_scenarios_uses_legume_counterfactual():
    result = calculate_ruminant_legume_swap_scenarios(_RUMINANT_ROWS, region="us")

    # 15 kg of ruminant meat at 41.44 kg CO2e/kg on average, replaced by legumes at 1.6, against
    # 634.4 kg CO2e institution-wide.
    expected = pd.DataFrame(
        {
            "scenario": [
                "10% ruminant-to-legume swap",
                "25% ruminant-to-legume swap",
                "50% ruminant-to-legume swap",
                "100% ruminant-to-legume swap",
            ],
            "substitution_pct": [10.0, 25.0, 50.0, 100.0],
            "source_categories": ["Beef and Buffalo Meat, Lamb/mutton & goat meat"] * 4,
            "replacement_category": ["Legumes"] * 4,
            "baseline_source_weight_kg": [15.0] * 4,
            "baseline_source_emissions_kg_co2e": [621.6] * 4,
            "replaced_weight_kg": [1.5, 3.75, 7.5, 15.0],
            "remaining_source_weight_kg": [13.5, 11.25, 7.5, 0.0],
            "replacement_weight_kg": [1.5, 3.75, 7.5, 15.0],
            "replacement_emission_factor_kg_co2e_per_kg": [1.6] * 4,
            "projected_emissions_kg_co2e": [561.84, 472.2, 322.8, 24.0],
            "avoidable_kg_co2e": [59.76, 149.4, 298.8, 597.6],
            "institution_emissions_avoided_pct": [9.42, 23.55, 47.1, 94.2],
        }
    )
    pd.testing.assert_frame_equal(result, expected)


def test_calculate_ruminant_legume_swap_scenarios_follows_the_region_and_levels():
    result = calculate_ruminant_legume_swap_scenarios(
        _RUMINANT_ROWS, region="europe", substitution_levels=(0.5,)
    )

    assert result["scenario"].tolist() == ["50% ruminant-to-legume swap"]
    assert result["replacement_emission_factor_kg_co2e_per_kg"].tolist() == [1.94]
    assert result["avoidable_kg_co2e"].tolist() == [271.7]


@pytest.mark.parametrize(
    "df",
    [
        pd.DataFrame(
            {
                "category": ["Legumes", "Vegetables"],
                "kilos_total": [10.0, 5.0],
                "emissions_kg_co2e": [16.0, 3.0],
            }
        ),
        pd.DataFrame(
            {
                "category": ["Beef and Buffalo Meat"],
                "kilos_total": [0.0],
                "emissions_kg_co2e": [0.0],
            }
        ),
    ],
    ids=["no-source-rows", "source-weighs-nothing"],
)
def test_calculate_category_swap_scenarios_is_an_empty_table_when_there_is_nothing_to_swap(df):
    result = calculate_ruminant_legume_swap_scenarios(df)

    assert result.empty
    assert list(result.columns) == _SWAP_COLUMNS


def test_calculate_milk_oat_swap_scenarios_uses_oat_milk_counterfactual():
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

    # 20 kg of cow's milk at 2.17 kg CO2e/kg, replaced by oat milk at 0.89, against 59.76 kg CO2e
    # institution-wide.
    expected = pd.DataFrame(
        {
            "scenario": [
                "10% cow's-milk-to-oat-milk swap",
                "20% cow's-milk-to-oat-milk swap",
                "50% cow's-milk-to-oat-milk swap",
                "100% cow's-milk-to-oat-milk swap",
            ],
            "substitution_pct": [10.0, 20.0, 50.0, 100.0],
            "source_categories": ["Milk (Cow's milk)"] * 4,
            "replacement_category": ["Oat Milk"] * 4,
            "baseline_source_weight_kg": [20.0] * 4,
            "baseline_source_emissions_kg_co2e": [43.4] * 4,
            "replaced_weight_kg": [2.0, 4.0, 10.0, 20.0],
            "remaining_source_weight_kg": [18.0, 16.0, 10.0, 0.0],
            "replacement_weight_kg": [2.0, 4.0, 10.0, 20.0],
            "replacement_emission_factor_kg_co2e_per_kg": [0.89] * 4,
            "projected_emissions_kg_co2e": [40.84, 38.28, 30.6, 17.8],
            "avoidable_kg_co2e": [2.56, 5.12, 12.8, 25.6],
            "institution_emissions_avoided_pct": [4.28, 8.57, 21.42, 42.84],
        }
    )
    pd.testing.assert_frame_equal(result, expected)


def test_calculate_milk_oat_swap_scenarios_avoids_divide_by_zero_when_total_emissions_zero():
    df = pd.DataFrame(
        {
            "category": ["Milk (Cow's milk)"],
            "kilos_total": [20.0],
            "emissions_kg_co2e": [0.0],
        }
    )

    result = calculate_milk_oat_swap_scenarios(df, region="us")

    assert result["institution_emissions_avoided_pct"].tolist() == [0.0, 0.0, 0.0, 0.0]


def test_run_aggregation_pipeline_fills_the_procurement_tables_from_the_rows():
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
        top_n=1,
        region="us",
        diner_or_meal="diner",
    )

    assert result.animal_emissions_concentration == AnimalEmissionsConcentration(
        top_products=("beef mince",), top_products_kg_co2e=413.5, total_animal_kg_co2e=687.2
    )
    assert result.animal_emissions_intensity is not None
    assert result.animal_emissions_intensity["category"].tolist() == [
        "Beef and Buffalo Meat",
        "Lamb/mutton & goat meat",
        "Milk (Cow's milk)",
    ]
    assert result.substitution_scenarios is not None
    assert result.substitution_scenarios["scenario"].tolist() == [
        "10% ruminant-to-legume swap",
        "25% ruminant-to-legume swap",
        "50% ruminant-to-legume swap",
        "100% ruminant-to-legume swap",
        "10% cow's-milk-to-oat-milk swap",
        "20% cow's-milk-to-oat-milk swap",
        "50% cow's-milk-to-oat-milk swap",
        "100% cow's-milk-to-oat-milk swap",
    ]
    # Ranked by weight, so the 20 kg of milk leads.
    assert result.overall_drivers["product"].tolist() == ["whole milk"]
    assert result.category_drivers["product"].tolist() == [
        "beef mince",
        "lamb shoulder",
        "whole milk",
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
        diner_or_meal=diner_or_meal,
    )

    per_head = f"kilos per {diner_or_meal}"
    assert result.monthly_product[per_head].tolist() == pytest.approx([0.1, 0.2, 0.125])
    assert result.monthly_category[per_head].tolist() == pytest.approx([0.3, 0.125])
    assert result.monthly_category["emissions_kg_co2e"].tolist() == pytest.approx([27.0, 13.5])


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
        diner_or_meal="diner",
    )

    assert (
        result.animal_emissions_intensity,
        result.animal_emissions_concentration,
        result.substitution_scenarios,
    ) == (None, None, None)


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
