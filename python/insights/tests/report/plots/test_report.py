from collections.abc import Callable
from typing import Any

import matplotlib.pyplot as plt
import pandas as pd
import pytest
from gbd_foodservice_insights.report.plots import report
from matplotlib.figure import Figure

JAN, FEB = pd.period_range("2023-01", periods=2, freq="M")
DINER_MEALS = {JAN: 100, FEB: 100}
EMISSIONS_SUMMARY = pd.DataFrame({"category": ["fruit", "juice"], "total_kg_co2e": [75, 13]})


def _figure_title(fig: Figure) -> str:
    """Return a figure-level title when present, otherwise its first panel title."""
    return fig.get_suptitle() or fig.axes[0].get_title()


def _aggregated_data(
    monthly_category_data: pd.DataFrame,
    *,
    category_drivers: pd.DataFrame | None = None,
) -> dict[str, pd.DataFrame]:
    """Aggregates where apple drives everything, for tests that only vary the months."""
    return {
        "monthly_category_data": monthly_category_data,
        "overall_drivers": pd.DataFrame({"product": ["apple"], "percentage": [100.0]}),
        "category_drivers": (
            category_drivers
            if category_drivers is not None
            else pd.DataFrame({"category": ["fruit"], "product": ["apple"], "percentage": [100.0]})
        ),
    }


@pytest.mark.parametrize(
    ("x_label", "expected"),
    [
        ("carbon  emissions by CATEGORY ", ""),
        ("Total kg CO2e", "Total kg CO2e"),
    ],
    ids=["repeats the title", "says something else"],
)
def test_remove_duplicate_xlabels_clears_only_an_x_label_that_repeats_the_title(
    x_label: str, expected: str
):
    fig, ax = plt.subplots()
    ax.set_title("Carbon Emissions by Category")
    ax.set_xlabel(x_label)

    cleaned = report._remove_duplicate_xlabels(fig)

    assert cleaned.axes[0].get_xlabel() == expected


def test_generate_all_report_plots_orders_every_page(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    plots_output = report.generate_all_report_plots(
        aggregated_data=_aggregated_data(fruit_and_juice_months(emissions_kg_co2e=[30, 5, 45, 8])),
        diner_meal_mapping=DINER_MEALS,
        emissions_summary=EMISSIONS_SUMMARY,
        metric_total="kilos_total",
        plant_animal_split={"plant_pct": 52.0},
    )

    assert [caption for caption, _ in plots_output] == [""] * len(plots_output)
    assert [_figure_title(fig) for _, fig in plots_output] == [
        "Number of Diners by Month",
        "Kilos Over Time",
        "Kilos by Category Across All Months",
        "Carbon Emissions by Category",
        "Carbon Emissions Over Time",
        "Plant and Protein Breakdown",
        "Top Products Driving Overall (Kilos)",
        "Top Products by Category",
    ]


@pytest.mark.parametrize(
    ("options", "drop_emissions_column", "expected_carbon_pages"),
    [
        ({"emissions_summary": EMISSIONS_SUMMARY, "serving": True}, False, []),
        ({}, False, []),
        ({"emissions_summary": EMISSIONS_SUMMARY}, True, ["Carbon Emissions by Category"]),
    ],
    ids=["serving report", "no emissions summary", "no monthly emissions"],
)
def test_generate_all_report_plots_leaves_out_pages_without_their_data(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
    options: dict[str, Any],
    drop_emissions_column: bool,
    expected_carbon_pages: list[str],
):
    months = fruit_and_juice_months(emissions_kg_co2e=[30, 5, 45, 8])
    if drop_emissions_column:
        months = months.drop(columns="emissions_kg_co2e")

    plots_output = report.generate_all_report_plots(
        aggregated_data=_aggregated_data(months),
        diner_meal_mapping=DINER_MEALS,
        metric_total="kilos_total",
        **options,
    )

    # No plant inputs either, so every case also leaves out the plant page.
    assert [_figure_title(fig) for _, fig in plots_output] == [
        "Number of Diners by Month",
        "Kilos Over Time",
        "Kilos by Category Across All Months",
        *expected_carbon_pages,
        "Top Products Driving Overall (Kilos)",
        "Top Products by Category",
    ]


@pytest.mark.usefixtures("fruit_and_juice")
def test_generate_all_report_plots_raises_for_untyped_categories():
    monthly_category_data = pd.DataFrame(
        {
            "month_year": [pd.Period("2023-01"), pd.Period("2023-01")],
            "category": ["fruit", "No Matches Found"],
            "kilos_total": [100, 25],
        }
    )

    with pytest.raises(ValueError, match="Unknown categories"):
        report.generate_all_report_plots(
            aggregated_data=_aggregated_data(monthly_category_data),
            diner_meal_mapping={JAN: 100},
            metric_total="kilos_total",
        )
