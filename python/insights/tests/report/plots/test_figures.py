from collections.abc import Callable

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights.report.aggregation import PlantAnimalSplit, PlantProteinShare
from gbd_foodservice_insights.report.metric import KILOS
from gbd_foodservice_insights.report.plots import figures
from matplotlib.figure import Figure

JAN, FEB = pd.period_range("2023-01", periods=2, freq="M")


def _figure_title(fig: Figure) -> str:
    """Return a figure-level title when present, otherwise its first panel title."""
    return fig.texts[0].get_text() if fig.texts else fig.axes[0].get_title()


def _is_stacked(top: plt.Axes, bottom: plt.Axes) -> bool:
    top_pos, bottom_pos = top.get_position(), bottom.get_position()
    return top_pos.y0 > bottom_pos.y0 and abs(top_pos.x0 - bottom_pos.x0) < 0.05


@pytest.mark.parametrize(
    ("category_count", "expected_pages"),
    [
        (4, [["Category 1", "Category 2", "Category 3", "Category 4"]]),
        (
            5,
            [
                ["Category 1", "Category 2", "Category 3", "Category 4"],
                ["Category 5", "", "", ""],
            ],
        ),
        (
            8,
            [
                ["Category 1", "Category 2", "Category 3", "Category 4"],
                ["Category 5", "Category 6", "Category 7", "Category 8"],
            ],
        ),
    ],
)
def test_plot_category_drivers_pages_puts_four_categories_on_each_page_in_order(
    category_count: int, expected_pages: list[list[str]]
):
    categories = [f"category {n}" for n in range(1, category_count + 1)]
    drivers = pd.DataFrame({"category": categories, "product": "apple", "percentage": 100.0})

    pages = figures.plot_category_drivers_pages(drivers, categories)

    assert [[ax.get_title() for ax in page.axes] for page in pages] == expected_pages
    assert [[ax.axison for ax in page.axes] for page in pages] == [
        [bool(title) for title in page] for page in expected_pages
    ]
    page_count = len(expected_pages)
    assert [page.get_suptitle() for page in pages] == (
        ["Top Products by Category"]
        if page_count == 1
        else [f"Top Products by Category ({n} of {page_count})" for n in range(1, page_count + 1)]
    )


def test_plot_category_totals_titles_and_labels_its_own_axes_with_categories_largest_first():
    monthly = pd.DataFrame(
        {
            "category": ["fruit", "fruit", "dairy"],
            "kilos_total": [10.0, 5.0, 20.0],
        }
    )

    fig = figures.plot_category_totals(monthly, KILOS)

    (ax,) = fig.axes
    assert ax.get_title() == "Kilos by Category Across All Months"
    assert ax.get_xlabel() == "Kilos"
    assert ax.get_ylabel() == ""
    assert [label.get_text() for label in ax.get_yticklabels()] == ["dairy", "fruit"]


def test_plot_diner_meal_numbers_pads_the_y_axis_by_a_fifth_of_each_limit():
    months = pd.period_range("2024-01", periods=3, freq="M")

    fig = figures.plot_diner_meal_numbers(pd.Series([10, 20, 30], index=months))

    (ax,) = fig.axes
    assert ax.get_ylim() == pytest.approx((8, 36))
    assert [label.get_text() for label in ax.get_xticklabels()] == [
        "Jan-2024",
        "Feb-2024",
        "Mar-2024",
    ]


def test_plot_emissions_by_category_labels_each_bar_with_its_share_skipping_missing_ones():
    fig = figures.plot_emissions_by_category(
        pd.DataFrame(
            {
                "category": ["fruit", "juice", "beef"],
                "total_kg_co2e": [75.0, 13.0, 1.0],
                "pct_of_total": [84.3, 14.6, np.nan],
            }
        )
    )

    # Bars run in ascending order of emissions, bottom to top.
    assert [text.get_text() for text in fig.axes[0].texts] == ["14.6%", "84.3%"]


def test_food_and_drink_comparison_page_puts_totals_above_per_diner(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    fig = figures.plot_food_and_drink_comparison_page(
        fruit_and_juice_months(),
        metric=KILOS,
        diner_meal_mapping={JAN: 100, FEB: 100},
    )

    assert _figure_title(fig) == "Kilos Over Time"
    assert [ax.get_title() for ax in fig.axes] == ["Total Kilos", "Kilos per Diner"]
    assert _is_stacked(*fig.axes)


def test_food_and_drink_comparison_page_requires_diner_meals(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    with pytest.raises(ValueError, match="diner_meal_mapping is required"):
        figures.plot_food_and_drink_comparison_page(fruit_and_juice_months())


def test_emissions_summary_page_puts_total_above_per_diner(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    fig = figures.plot_emissions_summary_over_time(
        fruit_and_juice_months(emissions_kg_co2e=[30, 5, 45, 8]),
        {JAN: 100, FEB: 100},
    )

    assert _figure_title(fig) == "Carbon Emissions Over Time"
    assert [ax.get_title() for ax in fig.axes] == [
        "Total Carbon Emissions Over Time",
        "Carbon Emissions per Diner Over Time",
    ]
    assert _is_stacked(*fig.axes)


def test_plant_breakdown_overview_puts_the_split_above_protein_with_monthly_on_the_right():
    fig = figures.plot_plant_breakdown_overview(
        PlantAnimalSplit(
            plant_pct=52.0,
            animal_pct=48.0,
            plant_total=52.0,
            animal_total=48.0,
            monthly=pd.DataFrame({"month_year": [JAN, FEB], "plant_pct": [48.0, 55.3]}),
        ),
        PlantProteinShare(
            plant_protein_pct=55.0,
            plant_protein_total=55.0,
            protein_total=100.0,
            monthly=pd.DataFrame({"month_year": [JAN, FEB], "plant_protein_pct": [50.0, 59.2]}),
        ),
    )

    assert _figure_title(fig) == "Plant and Protein Breakdown"
    # Row-major: top left, top right, bottom left, bottom right.
    assert [ax.get_title() for ax in fig.axes] == [
        "Plant vs. Animal Split",
        "Plant-Based % by Month",
        "Plant Protein Share",
        "Plant Protein % by Month",
    ]
