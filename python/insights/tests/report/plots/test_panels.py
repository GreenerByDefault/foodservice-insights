from collections.abc import Callable
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights.report.plots import panels
from matplotlib.patches import Rectangle


def _y_values(ax: plt.Axes) -> list[list[float]]:
    return [np.asarray(line.get_ydata()).tolist() for line in ax.lines]


def _texts(ax: plt.Axes) -> list[str]:
    return [text.get_text() for text in ax.texts]


def test_prepare_monthly_trend_data_totals_by_month(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    plot_data, label = panels.prepare_monthly_trend_data(
        fruit_and_juice_months(), "kilos_total", per_diner_meal=False, diner_meal_mapping=None
    )

    assert label == "Total Kilos"
    assert plot_data.to_dict("list") == {"month_year": ["2023-01", "2023-02"], "value": [125, 190]}


def test_prepare_monthly_trend_data_divides_by_diner_meals(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    plot_data, label = panels.prepare_monthly_trend_data(
        fruit_and_juice_months(),
        "kilos_total",
        per_diner_meal=True,
        diner_meal_mapping={"2023-01": 100, "2023-02": 50},
    )

    assert label == "kilos per diner-meal"
    assert plot_data.to_dict("list") == {"month_year": ["2023-01", "2023-02"], "value": [1.25, 3.8]}


def test_prepare_monthly_trend_data_requires_diner_meals_per_diner(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    with pytest.raises(ValueError, match="diner_meal_mapping is required"):
        panels.prepare_monthly_trend_data(
            fruit_and_juice_months(), "kilos_total", per_diner_meal=True, diner_meal_mapping=None
        )


def test_draw_food_and_drink_totals_draws_food_only_then_food_and_drink(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    _fig, ax = plt.subplots()

    panels.draw_food_and_drink_totals(ax, fruit_and_juice_months(), metric="kilos_total")

    assert ax.get_title() == "Total Kilos"
    assert [line.get_label() for line in ax.lines] == ["Food Only", "Food + Drink"]
    assert _y_values(ax) == [[100, 150], [125, 190]]
    assert ax.get_ylim() == (0, 190 * 1.2)


def test_draw_food_and_drink_totals_leaves_out_food_only_when_there_is_none(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    months = fruit_and_juice_months()
    _fig, ax = plt.subplots()

    panels.draw_food_and_drink_totals(ax, months[months["category"] == "juice"])

    assert [line.get_label() for line in ax.lines] == ["Food + Drink"]
    assert _y_values(ax) == [[25, 40]]


def test_draw_food_and_drink_totals_gives_an_all_zero_trend_a_unit_axis(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    _fig, ax = plt.subplots()

    panels.draw_food_and_drink_totals(ax, fruit_and_juice_months().assign(kilos_total=0))

    assert ax.get_ylim() == (0, 1)


def test_draw_food_and_drink_per_diner_divides_by_diner_meals(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    _fig, ax = plt.subplots()

    panels.draw_food_and_drink_per_diner(
        ax,
        fruit_and_juice_months(),
        {"2023-01": 100, "2023-02": 100},
        metric="kilos_total",
        diner_or_meal="meal",
    )

    assert ax.get_title() == "Kilos per Meal"
    assert _y_values(ax) == [[1.0, 1.5], [1.25, 1.9]]


@pytest.mark.parametrize(
    "without_data",
    [
        lambda months: months.iloc[0:0],
        lambda months: months.drop(columns="category"),
    ],
    ids=["no rows", "no category column"],
)
def test_draw_food_and_drink_totals_says_so_when_no_category_matches(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
    without_data: Callable[[pd.DataFrame], pd.DataFrame],
):
    _fig, ax = plt.subplots()

    panels.draw_food_and_drink_totals(ax, without_data(fruit_and_juice_months()))

    assert not ax.axison
    assert _texts(ax) == ["No matching category data available."]


def test_draw_food_and_drink_totals_rejects_a_metric_without_food_and_drink(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    _fig, ax = plt.subplots()

    with pytest.raises(ValueError, match="metric must be"):
        panels.draw_food_and_drink_totals(ax, fruit_and_juice_months(), metric="emissions_kg_co2e")


def test_draw_total_emissions_labels_a_narrow_range_from_zero(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    _fig, ax = plt.subplots()

    panels.draw_total_emissions(ax, fruit_and_juice_months(emissions_kg_co2e=[1000, 67, 1100, 92]))

    assert ax.get_title() == "Total Carbon Emissions Over Time"
    assert _y_values(ax) == [[1067.0, 1192.0]]
    assert ax.get_ylim()[0] == 0
    labels = ax.yaxis.get_major_formatter().format_ticks(ax.get_yticks().tolist())
    assert len(set(labels)) == len(labels)
    assert "1,200" in labels


def test_draw_emissions_per_diner_divides_by_diner_meals(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    _fig, ax = plt.subplots()

    panels.draw_emissions_per_diner(
        ax,
        fruit_and_juice_months(emissions_kg_co2e=[30, 5, 45, 8]),
        {"2023-01": 10, "2023-02": 20},
    )

    assert ax.get_title() == "Carbon Emissions per Diner Over Time"
    assert _y_values(ax) == [[3.5, 2.65]]
    assert ax.get_ylim()[0] == 0


def test_draw_plant_animal_split_labels_both_shares():
    _fig, ax = plt.subplots()

    panels.draw_plant_animal_split(ax, {"plant_pct": 52.0}, metric_label="Servings")

    assert ax.get_title() == "Plant vs. Animal Split"
    assert ax.get_xlabel() == "% of total servings (plant + animal categories only)"
    assert ax.get_legend_handles_labels()[1] == [
        "Plant-based (52.0%)",
        "Animal-based (48.0%)",
    ]


def test_draw_plant_protein_share_labels_both_shares():
    _fig, ax = plt.subplots()

    panels.draw_plant_protein_share(ax, {"plant_protein_pct": 55.0})

    assert ax.get_title() == "Plant Protein Share"
    assert ax.get_xlabel() == "% of total kilos in protein categories"
    assert ax.get_legend_handles_labels()[1] == [
        "Plant protein (55.0%)",
        "Other protein (45.0%)",
    ]


@pytest.mark.parametrize(
    ("draw", "share", "expected"),
    [
        (
            panels.draw_plant_share_by_month,
            {
                "monthly": pd.DataFrame(
                    {"month_year": ["2023-02", "2023-01"], "plant_pct": [55.3, 48.0]}
                )
            },
            "Plant-Based % by Month",
        ),
        (
            panels.draw_plant_protein_share_by_month,
            {
                "monthly": pd.DataFrame(
                    {"month_year": ["2023-02", "2023-01"], "plant_protein_pct": [55.3, 48.0]}
                )
            },
            "Plant Protein % by Month",
        ),
    ],
)
def test_monthly_plant_drawers_plot_the_share_in_month_order(
    draw: Callable[[plt.Axes, dict[str, Any]], None], share: dict[str, Any], expected: str
):
    _fig, ax = plt.subplots()

    draw(ax, share)

    assert ax.get_title() == expected
    assert _y_values(ax) == [[48.0, 55.3], [50, 50]]  # The second is the 50% reference line.


@pytest.mark.parametrize(
    ("draw", "share", "expected"),
    [
        (
            panels.draw_plant_animal_split,
            None,
            ["Plant vs. Animal Split", "Plant/animal data was not available."],
        ),
        (
            panels.draw_plant_protein_share,
            None,
            ["Plant Protein Share", "Plant protein data was not available."],
        ),
        (
            panels.draw_plant_share_by_month,
            None,
            ["Plant-Based % by Month", "Monthly plant/animal data was not available."],
        ),
        (
            panels.draw_plant_share_by_month,
            {"plant_pct": 52.0},
            ["Plant-Based % by Month", "Monthly plant/animal data was not available."],
        ),
        (
            panels.draw_plant_protein_share_by_month,
            {"plant_protein_pct": 55.0, "monthly": pd.DataFrame({"month_year": ["2023-01"]})},
            ["Plant Protein % by Month", "Monthly plant protein data was not available."],
        ),
        (
            panels.draw_plant_protein_share_by_month,
            {"plant_protein_pct": 55.0, "monthly": pd.DataFrame()},
            ["Plant Protein % by Month", "Monthly plant protein data was not available."],
        ),
    ],
)
def test_plant_drawers_keep_their_title_when_data_is_unavailable(
    draw: Callable[[plt.Axes, dict[str, Any] | None], None],
    share: dict[str, Any] | None,
    expected: list[str],
):
    _fig, ax = plt.subplots()

    draw(ax, share)

    assert not ax.axison
    assert _texts(ax) == expected


CATEGORY_DRIVERS = pd.DataFrame(
    {
        "category": ["fruit", "fruit", "juice"],
        "product": ["apple", "banana", "apple juice"],
        "percentage": [60.0, 40.0, 100.0],
    }
)


def test_draw_category_drivers_draws_only_its_categorys_products():
    _fig, ax = plt.subplots()

    panels.draw_category_drivers(ax, CATEGORY_DRIVERS, "fruit", metric_label="Servings")

    assert ax.get_title() == "Fruit"
    assert ax.get_xlabel() == "% of category servings"
    assert [label.get_text() for label in ax.get_yticklabels()] == ["apple", "banana"]
    assert [bar.get_width() for bar in ax.patches if isinstance(bar, Rectangle)] == [60.0, 40.0]


def test_draw_category_drivers_rejects_a_category_without_drivers():
    _fig, ax = plt.subplots()

    with pytest.raises(ValueError, match="No drivers for category 'beef'"):
        panels.draw_category_drivers(ax, CATEGORY_DRIVERS, "beef")
