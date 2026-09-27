from collections.abc import Callable

import pandas as pd
from gbd_foodservice_insights.report.plots import figures
from matplotlib.figure import Figure


def _figure_title(fig: Figure) -> str:
    """Return a figure-level title when present, otherwise its first panel title."""
    return fig.texts[0].get_text() if fig.texts else fig.axes[0].get_title()


def test_plot_category_drivers_draws_one_titled_chart_per_category():
    drivers = pd.DataFrame(
        {
            "category": ["fruit", "fruit", "farmer's oat milk"],
            "product": ["apple", "banana", "oat milk"],
            "percentage": ["60.0%", "40.0%", "100.0%"],
        }
    )

    figs = figures.plot_category_drivers(drivers, metric="kilos_total")

    assert {category: _figure_title(fig) for category, fig in figs.items()} == {
        "fruit": "Top Products Driving Fruit",
        "farmer's oat milk": "Top Products Driving Farmer's Oat Milk",
    }


def test_food_and_drink_comparison_page_puts_totals_beside_per_diner(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    fig = figures.plot_food_and_drink_comparison_page(
        fruit_and_juice_months(),
        metric="kilos_total",
        diner_meal_mapping={"2023-01": 100, "2023-02": 100},
    )

    assert _figure_title(fig) == "Kilos Over Time"
    assert [ax.get_title() for ax in fig.axes] == ["Total Kilos", "Kilos per Diner"]
