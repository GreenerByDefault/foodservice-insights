"""Report figures, each a PDF page: single charts, and pages laid out from `panels`."""

from typing import Any

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns
from matplotlib.figure import Figure

from gbd_foodservice_insights.plotting_utils import (
    LETTER_LANDSCAPE,
    GBD_colors,
    add_grid,
    convert_percentage_to_float,
    create_horizontal_percentage_barplot,
    format_month_labels,
    set_suptitle_font,
    set_title_font,
    set_ylim_with_padding,
    standardize_title_case,
)
from gbd_foodservice_insights.report.plots.panels import (
    draw_emissions_per_diner,
    draw_food_and_drink_per_diner,
    draw_food_and_drink_totals,
    draw_plant_animal_split,
    draw_plant_protein_share,
    draw_plant_protein_share_by_month,
    draw_plant_share_by_month,
    draw_total_emissions,
)
from gbd_foodservice_insights.report.schema import metric_display_label


def plot_diner_meal_numbers(
    diner_meal_mapping: dict[Any, Any] | pd.Series,
    diner_or_meal: str = "diner",
) -> Figure:
    """Line graph of diner-meal counts per month."""
    if isinstance(diner_meal_mapping, dict):
        diner_meal_series = pd.Series(diner_meal_mapping).sort_index()
    else:
        diner_meal_series = pd.Series(diner_meal_mapping).sort_index()

    fig, ax = plt.subplots(figsize=LETTER_LANDSCAPE)
    x_positions = range(len(diner_meal_series))
    ax.plot(x_positions, diner_meal_series.values, marker="o")
    set_title_font(ax, f"Number of {diner_or_meal.title()}s by Month")
    ax.set_xlabel("Month")
    set_ylim_with_padding(ax, diner_meal_series, padding=0.2)
    ax.set_ylabel(f"Number of {diner_or_meal.title()}s")
    add_grid(ax)

    formatted_labels = format_month_labels(diner_meal_series.index)
    ax.set_xticks(x_positions)
    ax.set_xticklabels(formatted_labels, rotation=45)

    plt.tight_layout()
    return fig


def plot_category_drivers(
    top_drivers: pd.DataFrame,
    metric: str = "kilos per diner-meal",
    total_products: int | None = None,
) -> dict[str, Figure]:
    """Bar charts of top products driving each category."""
    categories = top_drivers["category"].dropna().unique()
    figs: dict[str, Figure] = {}
    max_label_width = 30

    for category in categories:
        data = top_drivers[top_drivers["category"] == category].copy()
        data = convert_percentage_to_float(data, "percentage")

        fig, ax = plt.subplots(figsize=LETTER_LANDSCAPE)
        create_horizontal_percentage_barplot(
            ax=ax,
            data=data,
            y_col="product",
            percentage_col="percentage",
            max_label_width=max_label_width,
            add_percentage_labels=False,
        )
        ax.set_xlabel("Percentage of Category Total (%)")
        ax.set_ylabel("")
        title = f"Top Products Driving {standardize_title_case(category)}"
        if total_products:
            title += f" ({total_products} total products)"
        set_title_font(ax, title)
        plt.tight_layout()
        figs[str(category)] = fig

    return figs


def plot_overall_drivers(overall_drivers: pd.DataFrame, metric: str = "kilos_total") -> Figure:
    """Horizontal bar chart of top products driving overall totals."""
    overall_drivers = convert_percentage_to_float(overall_drivers, "percentage")

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
    metric_label = metric_display_label(metric)
    ax.set_xlabel("Percentage of Overall Total (%)")
    ax.set_ylabel("")
    set_title_font(ax, f"Top Products Driving Overall ({metric_label})")
    plt.tight_layout()
    return fig


def plot_category_totals(monthly_category_data: pd.DataFrame, metric: str) -> Figure:
    """Horizontal bar chart of total metric by category."""
    category_totals = monthly_category_data.groupby("category", as_index=False, dropna=False)[
        metric
    ].sum(min_count=1)
    metric_label = metric_display_label(metric)

    fig, ax = plt.subplots(figsize=LETTER_LANDSCAPE)
    sns.barplot(
        data=category_totals,
        y="category",
        x=metric,
        order=category_totals.sort_values(metric, ascending=False)["category"],
        ax=ax,
    )
    plt.yticks(fontsize=10)
    plt.title(
        f"{metric_label} by Category Across All Months",
        fontsize=14,
        fontfamily="Montserrat",
    )
    plt.xlabel(metric_label)
    plt.ylabel("")
    plt.tight_layout()
    return fig


def plot_food_and_drink_comparison_page(
    monthly_category_data: pd.DataFrame,
    *,
    metric: str = "kilos_total",
    diner_meal_mapping: dict[Any, Any] | None = None,
    diner_or_meal: str = "diner",
) -> Figure:
    """Create one page with total and per-diner trends, each comparing food vs food + drink."""
    if diner_meal_mapping is None:
        raise ValueError("diner_meal_mapping is required for the comparison page")

    fig, axes = plt.subplots(2, 1, figsize=LETTER_LANDSCAPE)
    set_suptitle_font(fig, f"{metric_display_label(metric)} Over Time", fontsize=16)
    draw_food_and_drink_totals(axes[0], monthly_category_data, metric=metric)
    draw_food_and_drink_per_diner(
        axes[1],
        monthly_category_data,
        diner_meal_mapping,
        metric=metric,
        diner_or_meal=diner_or_meal,
    )
    fig.tight_layout(rect=(0, 0, 1, 0.94))
    return fig


def plot_emissions_by_category(emissions_summary: pd.DataFrame) -> Figure:
    """Horizontal bar chart of total CO2e by category, with % of total labels."""
    data = emissions_summary.sort_values("total_kg_co2e", ascending=True).copy()

    fig, ax = plt.subplots(figsize=LETTER_LANDSCAPE)
    bars = ax.barh(data["category"], data["total_kg_co2e"], color=GBD_colors[0])
    ax.set_xlabel("Total kg CO2e")
    set_title_font(ax, "Carbon Emissions by Category")
    add_grid(ax, axis="x")

    # Add percentage labels at the right end of each bar
    if "pct_of_total" in data.columns:
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
    diner_meal_mapping: dict[Any, Any],
    emissions_col: str = "emissions_kg_co2e",
    diner_or_meal: str = "diner",
) -> Figure:
    """Put total and per-diner emissions trends together on one report page."""
    fig, axes = plt.subplots(2, 1, figsize=LETTER_LANDSCAPE)
    set_suptitle_font(fig, "Carbon Emissions Over Time", fontsize=16)
    draw_total_emissions(axes[0], monthly_category_data, emissions_col=emissions_col)
    draw_emissions_per_diner(
        axes[1],
        monthly_category_data,
        diner_meal_mapping,
        emissions_col=emissions_col,
        diner_or_meal=diner_or_meal,
    )
    fig.tight_layout(rect=(0, 0, 1, 0.92))
    return fig


def plot_plant_breakdown_overview(
    plant_animal_split: dict[str, Any] | None,
    plant_protein_share: dict[str, Any] | None,
    metric_label: str = "Kilos",
) -> Figure:
    """Combine the plant and protein share visuals into a single four-panel page."""
    fig, axes = plt.subplots(2, 2, figsize=LETTER_LANDSCAPE)
    set_suptitle_font(fig, "Plant and Protein Breakdown", fontsize=16)
    draw_plant_animal_split(axes[0, 0], plant_animal_split, metric_label=metric_label)
    draw_plant_share_by_month(axes[0, 1], plant_animal_split)
    draw_plant_protein_share(axes[1, 0], plant_protein_share, metric_label=metric_label)
    draw_plant_protein_share_by_month(axes[1, 1], plant_protein_share)
    fig.tight_layout(rect=(0, 0, 1, 0.93))
    return fig
