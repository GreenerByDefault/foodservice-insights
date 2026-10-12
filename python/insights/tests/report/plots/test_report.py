from collections.abc import Callable

import pandas as pd
from gbd_foodservice_insights.report.aggregation import Aggregation, PlantAnimalSplit
from gbd_foodservice_insights.report.plots import report
from matplotlib.figure import Figure

JAN, FEB = pd.period_range("2023-01", periods=2, freq="M")
DINER_MEALS = {JAN: 100, FEB: 100}
EMISSIONS_SUMMARY = pd.DataFrame(
    {"category": ["fruit", "juice"], "total_kg_co2e": [75, 13], "pct_of_total": [85.2, 14.8]}
)
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
        animal_emissions_intensity=None,
        animal_emissions_concentration=None,
        substitution_scenarios=None,
    )


def test_generate_all_report_plots_orders_every_page(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    plots_output = report.generate_all_report_plots(
        aggregation=_aggregation(fruit_and_juice_months(emissions_kg_co2e=[30, 5, 45, 8])),
        diner_meal_mapping=DINER_MEALS,
        emissions_summary=EMISSIONS_SUMMARY,
        plant_animal_split=PLANT_SPLIT,
        plant_protein_share=None,
        diner_or_meal="diner",
    )

    assert [_figure_title(fig) for fig in plots_output] == [
        "Number of Diners by Month",
        "Kilos Over Time",
        "Kilos by Category Across All Months",
        "Carbon Emissions by Category",
        "Carbon Emissions Over Time",
        "Plant and Protein Breakdown",
        "Top Products Driving Overall (Kilos)",
        "Top Products by Category",
    ]
