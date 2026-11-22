"""The report's full set of figures, in page order."""

import pandas as pd
from matplotlib.figure import Figure

from gbd_foodservice_insights.report.aggregation import (
    Aggregation,
    PlantAnimalSplit,
    PlantProteinShare,
)
from gbd_foodservice_insights.report.metric import KILOS
from gbd_foodservice_insights.report.plots.figures import (
    plot_category_drivers_pages,
    plot_category_totals,
    plot_diner_meal_numbers,
    plot_emissions_by_category,
    plot_emissions_summary_over_time,
    plot_food_and_drink_comparison_page,
    plot_overall_drivers,
    plot_plant_breakdown_overview,
)
from gbd_foodservice_insights.report.schema import Headcounts

TOP_PRODUCTS_CATEGORY_COUNT = 5


def _highest_emitting_categories(
    emissions_summary: pd.DataFrame, category_drivers: pd.DataFrame
) -> list[str]:
    """The categories with the most total kg CO2e that have drivers to chart, highest first."""
    with_drivers = emissions_summary.loc[
        emissions_summary["category"].isin(category_drivers["category"].dropna())
    ]
    return with_drivers.nlargest(TOP_PRODUCTS_CATEGORY_COUNT, "total_kg_co2e")["category"].tolist()


def generate_all_report_plots(
    aggregation: Aggregation,
    headcounts: Headcounts | None,
    emissions_summary: pd.DataFrame,
    plant_animal_split: PlantAnimalSplit,
    plant_protein_share: PlantProteinShare | None,
) -> list[Figure]:
    return [
        *(
            []
            if headcounts is None
            else [plot_diner_meal_numbers(headcounts.by_month, headcounts.diner_or_meal)]
        ),
        plot_food_and_drink_comparison_page(
            aggregation.monthly_category, metric=KILOS, headcounts=headcounts
        ),
        plot_category_totals(aggregation.monthly_category, KILOS),
        plot_emissions_by_category(emissions_summary),
        plot_emissions_summary_over_time(aggregation.monthly_category, headcounts),
        plot_plant_breakdown_overview(plant_animal_split, plant_protein_share, metric=KILOS),
        plot_overall_drivers(aggregation.overall_drivers, KILOS),
        *plot_category_drivers_pages(
            aggregation.category_drivers,
            _highest_emitting_categories(emissions_summary, aggregation.category_drivers),
            metric=KILOS,
        ),
    ]
