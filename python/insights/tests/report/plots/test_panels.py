from collections.abc import Callable
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights.report.plots import panels


def _y_values(ax: plt.Axes) -> list[list[float]]:
    return [np.asarray(line.get_ydata()).tolist() for line in ax.lines]


def _texts(ax: plt.Axes) -> list[str]:
    return [text.get_text() for text in ax.texts]


def test_draw_food_and_drink_totals_draws_food_only_then_food_and_drink(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    _fig, ax = plt.subplots()

    panels.draw_food_and_drink_totals(ax, fruit_and_juice_months(), metric="kilos_total")

    assert ax.get_title() == "Total Kilos"
    assert [line.get_label() for line in ax.lines] == ["Food Only", "Food + Drink"]
    assert _y_values(ax) == [[100, 150], [125, 190]]


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


def test_draw_food_and_drink_totals_says_so_when_no_category_matches(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    _fig, ax = plt.subplots()

    panels.draw_food_and_drink_totals(ax, fruit_and_juice_months().iloc[0:0])

    assert not ax.axison
    assert _texts(ax) == ["No matching category data available."]


def test_draw_food_and_drink_totals_rejects_a_metric_without_food_and_drink(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    _fig, ax = plt.subplots()

    with pytest.raises(ValueError, match="metric must be"):
        panels.draw_food_and_drink_totals(ax, fruit_and_juice_months(), metric="emissions_kg_co2e")


def test_draw_total_emissions_abbreviates_large_values(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    _fig, ax = plt.subplots()

    panels.draw_total_emissions(ax, fruit_and_juice_months(emissions_kg_co2e=[2e6, 5e5, 3e3, 12]))

    assert ax.get_title() == "Total Carbon Emissions Over Time"
    assert _y_values(ax) == [[2.5e6, 3012.0]]
    formatter = ax.yaxis.get_major_formatter()
    assert [formatter(value, None) for value in (2.5e6, 3012, 12)] == ["2.5M", "3k", "12"]


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
