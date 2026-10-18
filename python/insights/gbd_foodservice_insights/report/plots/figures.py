"""Report figures, each a PDF page: single charts, and pages laid out from `panels`."""

from collections.abc import Mapping, Sequence

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns
from matplotlib.figure import Figure

from gbd_foodservice_insights.plotting_utils import (
    GBD_COLORS,
    LETTER_LANDSCAPE,
    add_grid,
    create_horizontal_percentage_barplot,
    format_month_labels,
    set_suptitle_font,
    set_title_font,
)
from gbd_foodservice_insights.report.aggregation import PlantAnimalSplit, PlantProteinShare
from gbd_foodservice_insights.report.metric import KILOS, Metric
from gbd_foodservice_insights.report.plots.panels import (
    draw_category_drivers,
    draw_emissions_per_diner,
    draw_food_and_drink_per_diner,
    draw_food_and_drink_totals,
    draw_plant_animal_split,
    draw_plant_protein_share,
    draw_plant_protein_share_by_month,
    draw_plant_share_by_month,
    draw_total_emissions,
)
from gbd_foodservice_insights.report.schema import DinerOrMeal, Headcounts


def plot_diner_meal_numbers(
    diner_meal_mapping: Mapping[pd.Period, float],
    diner_or_meal: DinerOrMeal = "diner",
) -> Figure:
    """Line graph of diner-meal counts per month."""
    diner_meal_series = pd.Series(diner_meal_mapping).sort_index()

    fig, ax = plt.subplots(figsize=LETTER_LANDSCAPE)
    x_positions = range(len(diner_meal_series))
    ax.plot(x_positions, diner_meal_series.values, marker="o")
    set_title_font(ax, f"Number of {diner_or_meal.title()}s by Month")
    ax.set_xlabel("Month")
    # Padding is relative to each limit's value, not the range, so it assumes positive counts.
    ax.set_ylim(diner_meal_series.min() * 0.8, diner_meal_series.max() * 1.2)
    ax.set_ylabel(f"Number of {diner_or_meal.title()}s")
    add_grid(ax)

    formatted_labels = format_month_labels(diner_meal_series.index)
    ax.set_xticks(x_positions)
    ax.set_xticklabels(formatted_labels, rotation=45)

    plt.tight_layout()
    return fig


CATEGORY_DRIVERS_PER_PAGE = 4


def plot_category_drivers_pages(
    category_drivers: pd.DataFrame,
    categories: list[str],
    *,
    metric: Metric = KILOS,
) -> list[Figure]:
    """Each category's drivers, four to a page, in the order of `categories`."""
    page_chunks = [
        categories[start : start + CATEGORY_DRIVERS_PER_PAGE]
        for start in range(0, len(categories), CATEGORY_DRIVERS_PER_PAGE)
    ]
    pages: list[Figure] = []
    for page_number, page_categories in enumerate(page_chunks, start=1):
        fig, axes = plt.subplots(2, 2, figsize=LETTER_LANDSCAPE)
        title = "Top Products by Category"
        if len(page_chunks) > 1:
            title += f" ({page_number} of {len(page_chunks)})"
        set_suptitle_font(fig, title, fontsize=16)
        # A short last page keeps its panels the size of a full page's rather than stretching
        # them.
        for ax, category in zip(axes.flat, page_categories, strict=False):
            draw_category_drivers(ax, category_drivers, category, metric=metric)
        for ax in axes.flat[len(page_categories) :]:
            ax.axis("off")
        fig.tight_layout(rect=(0, 0, 1, 0.93))
        pages.append(fig)
    return pages


def plot_overall_drivers(overall_drivers: pd.DataFrame, metric: Metric = KILOS) -> Figure:
    """Horizontal bar chart of top products driving overall totals."""
    max_label_width = 30
    fig, ax = plt.subplots(figsize=LETTER_LANDSCAPE)
    create_horizontal_percentage_barplot(
        ax=ax,
        data=overall_drivers,
        y_col="product",
        percentage_col="percentage",
        max_label_width=max_label_width,
        add_percentage_labels=True,
    )
    ax.set_xlabel("Percentage of Overall Total (%)")
    ax.set_ylabel("")
    set_title_font(ax, f"Top Products Driving Overall ({metric.label})")
    plt.tight_layout()
    return fig


def plot_category_totals(monthly_category_data: pd.DataFrame, metric: Metric) -> Figure:
    """Horizontal bar chart of total metric by category."""
    category_totals = monthly_category_data.groupby("category", as_index=False, dropna=False)[
        metric.column
    ].sum(min_count=1)

    fig, ax = plt.subplots(figsize=LETTER_LANDSCAPE)
    sns.barplot(
        data=category_totals,
        y="category",
        x=metric.column,
        order=category_totals.sort_values(metric.column, ascending=False)["category"],
        ax=ax,
    )
    ax.tick_params(axis="y", labelsize=10)
    set_title_font(ax, f"{metric.label} by Category Across All Months")
    ax.set_xlabel(metric.label)
    ax.set_ylabel("")
    fig.tight_layout()
    return fig


def plot_food_and_drink_comparison_page(
    monthly_category_data: pd.DataFrame,
    *,
    metric: Metric = KILOS,
    headcounts: Headcounts | None,
) -> Figure:
    """One page of total trends, with per-head trends below them given headcounts, each
    comparing food against food + drink."""
    fig, axes = _trend_subplots(headcounts)
    set_suptitle_font(fig, f"{metric.label} Over Time", fontsize=16)
    draw_food_and_drink_totals(axes[0], monthly_category_data, metric=metric)
    if headcounts is not None:
        draw_food_and_drink_per_diner(
            axes[1],
            monthly_category_data,
            headcounts.by_month,
            metric=metric,
            diner_or_meal=headcounts.diner_or_meal,
        )
    fig.tight_layout(rect=(0, 0, 1, 0.94))
    return fig


def plot_emissions_by_category(emissions_summary: pd.DataFrame) -> Figure:
    """Horizontal bar chart of total CO₂e by category, with % of total labels."""
    data = emissions_summary.sort_values("total_kg_co2e", ascending=True).copy()

    fig, ax = plt.subplots(figsize=LETTER_LANDSCAPE)
    bars = ax.barh(data["category"], data["total_kg_co2e"], color=GBD_COLORS[0])
    ax.set_xlabel("Total kg CO₂e")
    set_title_font(ax, "Carbon Emissions by Category")
    add_grid(ax, axis="x")

    # Add percentage labels at the right end of each bar
    x_max = data["total_kg_co2e"].max()
    for bar, pct in zip(bars, data["pct_of_total"], strict=True):
        if pd.notna(pct) and x_max > 0:
            ax.text(
                bar.get_width() + x_max * 0.01,
                bar.get_y() + bar.get_height() / 2,
                f"{pct:.1f}%",
                va="center",
                ha="left",
                fontsize=8,
                color="gray",
            )
    ax.set_xlim(right=x_max * 1.15)

    plt.tight_layout()
    return fig


def plot_emissions_summary_over_time(
    monthly_category_data: pd.DataFrame,
    headcounts: Headcounts | None,
) -> Figure:
    """One page of the total emissions trend, with the per-head trend below it given
    headcounts."""
    fig, axes = _trend_subplots(headcounts)
    set_suptitle_font(fig, "Carbon Emissions Over Time", fontsize=16)
    draw_total_emissions(axes[0], monthly_category_data)
    if headcounts is not None:
        draw_emissions_per_diner(
            axes[1],
            monthly_category_data,
            headcounts.by_month,
            diner_or_meal=headcounts.diner_or_meal,
        )
    fig.tight_layout(rect=(0, 0, 1, 0.92))
    return fig


def _trend_subplots(headcounts: Headcounts | None) -> tuple[Figure, Sequence[plt.Axes]]:
    """A totals panel, and a per-head panel below it given headcounts."""
    rows = 1 if headcounts is None else 2
    fig, axes = plt.subplots(rows, 1, figsize=LETTER_LANDSCAPE, squeeze=False)
    return fig, list(axes[:, 0])


def plot_plant_breakdown_overview(
    plant_animal_split: PlantAnimalSplit,
    plant_protein_share: PlantProteinShare | None,
    metric: Metric = KILOS,
) -> Figure:
    """Combine the plant and protein share visuals into a single four-panel page."""
    fig, axes = plt.subplots(2, 2, figsize=LETTER_LANDSCAPE)
    set_suptitle_font(fig, "Plant and Protein Breakdown", fontsize=16)
    draw_plant_animal_split(axes[0, 0], plant_animal_split, metric=metric)
    draw_plant_share_by_month(axes[0, 1], plant_animal_split)
    draw_plant_protein_share(axes[1, 0], plant_protein_share, metric=metric)
    draw_plant_protein_share_by_month(axes[1, 1], plant_protein_share)
    fig.tight_layout(rect=(0, 0, 1, 0.93))
    return fig
