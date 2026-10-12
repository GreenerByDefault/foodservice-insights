"""The report's full set of figures, in page order."""

from collections.abc import Mapping

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
from gbd_foodservice_insights.report.schema import DinerOrMeal


def generate_all_report_plots(
    aggregation: Aggregation,
    diner_meal_mapping: Mapping[pd.Period, float],
    emissions_summary: pd.DataFrame,
    plant_animal_split: PlantAnimalSplit,
    plant_protein_share: PlantProteinShare | None,
    diner_or_meal: DinerOrMeal,
) -> list[Figure]:
    return [
        plot_diner_meal_numbers(diner_meal_mapping, diner_or_meal),
        plot_food_and_drink_comparison_page(
            aggregation.monthly_category,
            metric=KILOS,
            diner_meal_mapping=diner_meal_mapping,
            diner_or_meal=diner_or_meal,
        ),
        plot_category_totals(aggregation.monthly_category, KILOS),
        plot_emissions_by_category(emissions_summary),
        plot_emissions_summary_over_time(
            aggregation.monthly_category,
            diner_meal_mapping,
            diner_or_meal=diner_or_meal,
        ),
        plot_plant_breakdown_overview(plant_animal_split, plant_protein_share, metric=KILOS),
        plot_overall_drivers(aggregation.overall_drivers, KILOS),
        *plot_category_drivers_pages(
            aggregation.category_drivers,
            aggregation.category_drivers["category"].dropna().unique().tolist(),
            metric=KILOS,
        ),
    ]
