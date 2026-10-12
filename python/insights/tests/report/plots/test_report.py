from collections.abc import Callable
from typing import Any

import matplotlib.pyplot as plt
import pandas as pd
import pytest
from gbd_foodservice_insights.report.aggregation import Aggregation, PlantAnimalSplit
from gbd_foodservice_insights.report.metric import KILOS
from gbd_foodservice_insights.report.plots import report
from matplotlib.figure import Figure

JAN, FEB = pd.period_range("2023-01", periods=2, freq="M")
DINER_MEALS = {JAN: 100, FEB: 100}
EMISSIONS_SUMMARY = pd.DataFrame({"category": ["fruit", "juice"], "total_kg_co2e": [75, 13]})
PLANT_SPLIT = PlantAnimalSplit(
    plant_pct=100.0,
    animal_pct=0.0,
    plant_total=88.0,
    animal_total=0.0,
    monthly=pd.DataFrame({"month_year": [JAN, FEB], "plant_pct": [100.0, 100.0]}),
)


def _figure_title(fig: Figure) -> str:
    """Return a figure-level title when present, otherwise its first panel title."""
    return fig.get_suptitle() or fig.axes[0].get_title()


def _aggregation(
    monthly_category: pd.DataFrame,
    *,
    category_drivers: pd.DataFrame | None = None,
) -> Aggregation:
    """Aggregates where apple drives everything, for tests that only vary the months."""
    return Aggregation(
        # The plots never read these two.
        monthly_product=pd.DataFrame(),
        monthly_category=monthly_category,
        template=pd.DataFrame(),
        overall_drivers=pd.DataFrame({"product": ["apple"], "percentage": [100.0]}),
        category_drivers=(
            category_drivers
            if category_drivers is not None
            else pd.DataFrame({"category": ["fruit"], "product": ["apple"], "percentage": [100.0]})
        ),
        procurement=None,
    )


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
        aggregation=_aggregation(fruit_and_juice_months(emissions_kg_co2e=[30, 5, 45, 8])),
        diner_meal_mapping=DINER_MEALS,
        emissions_summary=EMISSIONS_SUMMARY,
        metric=KILOS,
        plant_animal_split=PLANT_SPLIT,
        plant_protein_share=None,
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
        aggregation=_aggregation(months),
        diner_meal_mapping=DINER_MEALS,
        plant_animal_split=PLANT_SPLIT,
        plant_protein_share=None,
        metric=KILOS,
        **options,
    )

    assert [_figure_title(fig) for _, fig in plots_output] == [
        "Number of Diners by Month",
        "Kilos Over Time",
        "Kilos by Category Across All Months",
        *expected_carbon_pages,
        "Plant and Protein Breakdown",
        "Top Products Driving Overall (Kilos)",
        "Top Products by Category",
    ]
