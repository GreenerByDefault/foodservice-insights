"""The report's full set of figures, in page order."""

from collections.abc import Mapping
from typing import Any

import pandas as pd
from matplotlib.figure import Figure

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
from gbd_foodservice_insights.report.plots.panels import filter_monthly_categories_by_type
from gbd_foodservice_insights.report.schema import metric_display_label


def _normalize_axis_text(value: str) -> str:
    """Normalize axis text so repeated labels can be compared safely."""
    return " ".join(str(value).split()).strip().casefold()


def _remove_duplicate_xlabels(fig: Figure) -> Figure:
    """Remove x-axis labels when they repeat the chart title.

    This stays as a shared cleanup step rather than being hard-coded into
    individual plots, so the report avoids repeated wording consistently
    anywhere this pattern appears in future charts.
    """
    for ax in fig.axes:
        title = ax.get_title()
        x_label = ax.get_xlabel()
        if not title or not x_label:
            continue
        if _normalize_axis_text(title) == _normalize_axis_text(x_label):
            ax.set_xlabel("")
    return fig


def generate_all_report_plots(
    aggregated_data: dict[str, Any],
    diner_meal_mapping: Mapping[pd.Period, float],
    emissions_summary: pd.DataFrame | None = None,
    metric_total: str = "kilos_total",
    serving: bool = False,
    plant_animal_split: dict[str, Any] | None = None,
    plant_protein_share: dict[str, Any] | None = None,
    diner_or_meal: str = "diner",
) -> list[tuple[str, Figure]]:
    """Generate all report plots and return ``(caption, figure)`` tuples."""
    monthly_cat = aggregated_data["monthly_category_data"]
    overall_drivers = aggregated_data["overall_drivers"]
    category_drivers = aggregated_data["category_drivers"]

    if not monthly_cat.empty:
        filter_monthly_categories_by_type(monthly_cat, include_drinks=True)

    metric_label = metric_display_label(metric_total)

    figures = [
        plot_diner_meal_numbers(diner_meal_mapping, diner_or_meal),
        plot_food_and_drink_comparison_page(
            monthly_cat,
            metric=metric_total,
            diner_meal_mapping=diner_meal_mapping,
            diner_or_meal=diner_or_meal,
        ),
        plot_category_totals(monthly_cat, metric_total),
    ]

    if emissions_summary is not None and not serving:
        figures.append(plot_emissions_by_category(emissions_summary))
        if "emissions_kg_co2e" in monthly_cat.columns:
            figures.append(
                plot_emissions_summary_over_time(
                    monthly_cat,
                    diner_meal_mapping,
                    diner_or_meal=diner_or_meal,
                )
            )

    if plant_animal_split is not None or plant_protein_share is not None:
        figures.append(
            plot_plant_breakdown_overview(
                plant_animal_split,
                plant_protein_share,
                metric_label=metric_label,
            )
        )

    figures.append(plot_overall_drivers(overall_drivers, metric_total))
    figures.extend(
        plot_category_drivers_pages(
            category_drivers,
            category_drivers["category"].dropna().unique().tolist(),
            metric_label=metric_label,
        )
    )

    return [("", _remove_duplicate_xlabels(fig)) for fig in figures]
