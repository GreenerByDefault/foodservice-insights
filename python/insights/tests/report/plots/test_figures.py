from collections.abc import Callable

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights.report.plots import figures
from matplotlib.figure import Figure


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
    drivers = pd.DataFrame({"category": categories, "product": "apple", "percentage": "100.0%"})

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
        metric="kilos_total",
        diner_meal_mapping={"2023-01": 100, "2023-02": 100},
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
        {"2023-01": 100, "2023-02": 100},
    )

    assert _figure_title(fig) == "Carbon Emissions Over Time"
    assert [ax.get_title() for ax in fig.axes] == [
        "Total Carbon Emissions Over Time",
        "Carbon Emissions per Diner Over Time",
    ]
    assert _is_stacked(*fig.axes)


def test_plant_breakdown_overview_puts_the_split_above_protein_with_monthly_on_the_right():
    months = ["2023-01", "2023-02"]
    fig = figures.plot_plant_breakdown_overview(
        {
            "plant_pct": 52.0,
            "monthly": pd.DataFrame({"month_year": months, "plant_pct": [48.0, 55.3]}),
        },
        {
            "plant_protein_pct": 55.0,
            "monthly": pd.DataFrame({"month_year": months, "plant_protein_pct": [50.0, 59.2]}),
        },
    )

    assert _figure_title(fig) == "Plant and Protein Breakdown"
    # Row-major: top left, top right, bottom left, bottom right.
    assert [ax.get_title() for ax in fig.axes] == [
        "Plant vs. Animal Split",
        "Plant-Based % by Month",
        "Plant Protein Share",
        "Plant Protein % by Month",
    ]
