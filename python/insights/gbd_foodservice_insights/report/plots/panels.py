"""Chart panels: each `draw_*` fills an `Axes` it is handed, empty state included."""

import math
from collections.abc import Mapping

import matplotlib.pyplot as plt
import pandas as pd

from gbd_foodservice_insights.categories import drink_categories, food_categories
from gbd_foodservice_insights.plotting_utils import (
    GBD_COLORS,
    GBD_GREEN,
    GBD_MUTED,
    add_grid,
    create_horizontal_percentage_barplot,
    format_month_labels,
    group_thousands,
    set_title_font,
    standardize_title_case,
)
from gbd_foodservice_insights.report.aggregation import (
    PlantAnimalSplit,
    PlantProteinShare,
    monthly_totals,
)
from gbd_foodservice_insights.report.metric import KILOS, Metric
from gbd_foodservice_insights.report.schema import DinerOrMeal


def prepare_monthly_trend_data(
    monthly_category_data: pd.DataFrame,
    metric: str,
    *,
    per_diner_meal: bool,
    diner_meal_mapping: Mapping[pd.Period, float] | None,
) -> pd.DataFrame:
    """Prepare canonical monthly trend table for plotting."""
    totals = monthly_totals(monthly_category_data, metric)

    if per_diner_meal:
        if diner_meal_mapping is None:
            raise ValueError("diner_meal_mapping is required when per_diner_meal=True")
        values = _per_diner(totals, diner_meal_mapping)
    else:
        values = totals

    return pd.DataFrame({"month_year": values.index, "value": values.values})


def _per_diner(monthly: pd.Series, diner_meal_mapping: Mapping[pd.Period, float]) -> pd.Series:
    # A month without a count comes out NaN; `build_food_report` refuses one before any chart.
    return monthly / monthly.index.map(dict(diner_meal_mapping))


def filter_monthly_categories_by_type(
    monthly_category_data: pd.DataFrame,
    *,
    include_drinks: bool,
) -> pd.DataFrame:
    """Filter monthly category data to food only or food + drink categories."""
    categories = food_categories() + drink_categories() if include_drinks else food_categories()
    return monthly_category_data[monthly_category_data["category"].isin(categories)].copy()


def _draw_unavailable(ax: plt.Axes, title: str, message: str) -> None:
    """Stand in for a panel whose data is missing, keeping its title."""
    ax.axis("off")
    ax.text(0.5, 0.6, title, ha="center", va="center", fontsize=12, fontweight="bold")
    ax.text(0.5, 0.42, message, ha="center", va="center", fontsize=10, color=GBD_MUTED)


def _set_ylim_from_zero(ax: plt.Axes, series: list[pd.Series]) -> None:
    """Anchor the y-axis at 0 so a small swing is not drawn as a large one."""
    y_max = max(
        (
            float(max_value)
            for values in series
            if pd.notna(max_value := pd.to_numeric(values, errors="coerce").max())
        ),
        default=0.0,
    )
    if y_max > 0:
        ax.set_ylim(0, y_max * 1.2)
    elif y_max == 0:
        ax.set_ylim(0, 1)


def _draw_metric_over_time_on_axis(
    ax: plt.Axes,
    plot_data: pd.DataFrame,
    *,
    title: str,
    y_label: str,
) -> None:
    """Draw a simple monthly trend line on a provided axis."""
    data_sorted = plot_data.sort_values("month_year").copy()
    x_positions = list(range(len(data_sorted)))

    ax.plot(
        x_positions,
        data_sorted["value"].values,
        marker="o",
        linewidth=2,
        color=GBD_GREEN,
    )
    ax.set_xticks(x_positions)
    ax.set_xticklabels(format_month_labels(data_sorted["month_year"]), rotation=45)
    ax.set_ylabel(y_label)
    set_title_font(ax, title)
    add_grid(ax)
    group_thousands(ax.yaxis)
    _set_ylim_from_zero(ax, [data_sorted["value"]])


def _draw_multi_series_metric_over_time_on_axis(
    ax: plt.Axes,
    series_payloads: list[tuple[str, pd.DataFrame]],
    *,
    title: str,
    y_label: str,
) -> None:
    """Draw multiple monthly trend lines on a provided axis."""
    non_empty_payloads = [
        (label, plot_data.sort_values("month_year").copy())
        for label, plot_data in series_payloads
        if not plot_data.empty
    ]

    if not non_empty_payloads:
        ax.axis("off")
        ax.text(
            0.5,
            0.5,
            "No matching category data available.",
            ha="center",
            va="center",
            fontsize=10,
            color=GBD_MUTED,
        )
        return

    month_order = pd.Index([])
    for _, plot_data in non_empty_payloads:
        month_order = month_order.union(pd.Index(plot_data["month_year"]))
    month_order = month_order.sort_values()
    x_positions = list(range(len(month_order)))
    month_to_x = {month: idx for idx, month in enumerate(month_order)}

    for idx, (label, plot_data) in enumerate(non_empty_payloads):
        color = GBD_COLORS[idx % len(GBD_COLORS)]
        x_values = [month_to_x[month] for month in plot_data["month_year"]]
        ax.plot(
            x_values,
            plot_data["value"].values,
            marker="o",
            linewidth=2,
            label=label,
            color=color,
        )

    ax.set_xticks(x_positions)
    ax.set_xticklabels(format_month_labels(month_order), rotation=45)
    ax.set_ylabel(y_label)
    set_title_font(ax, title)
    add_grid(ax)
    ax.legend(frameon=False)
    group_thousands(ax.yaxis)
    _set_ylim_from_zero(ax, [plot_data["value"] for _, plot_data in non_empty_payloads])


def _food_and_drink_trends(
    monthly_category_data: pd.DataFrame,
    metric: str,
    *,
    per_diner_meal: bool,
    diner_meal_mapping: Mapping[pd.Period, float] | None = None,
) -> list[tuple[str, pd.DataFrame]]:
    """Monthly trends of `metric` for food only and for food + drink, as labeled series."""
    if metric not in {"kilos_total", "servings total"}:
        raise ValueError("metric must be 'kilos_total' or 'servings total'")

    def trend(*, include_drinks: bool) -> pd.DataFrame:
        subset = filter_monthly_categories_by_type(
            monthly_category_data, include_drinks=include_drinks
        )
        if subset.empty:
            return pd.DataFrame(columns=["month_year", "value"])
        return prepare_monthly_trend_data(
            subset,
            metric,
            per_diner_meal=per_diner_meal,
            diner_meal_mapping=diner_meal_mapping,
        )

    return [
        ("Food Only", trend(include_drinks=False)),
        ("Food + Drink", trend(include_drinks=True)),
    ]


def draw_food_and_drink_totals(
    ax: plt.Axes,
    monthly_category_data: pd.DataFrame,
    *,
    metric: Metric = KILOS,
) -> None:
    """Total `metric` by month, food only against food + drink."""
    title = f"Total {metric.label}"
    _draw_multi_series_metric_over_time_on_axis(
        ax,
        _food_and_drink_trends(monthly_category_data, metric.column, per_diner_meal=False),
        title=title,
        y_label=title,
    )


def draw_food_and_drink_per_diner(
    ax: plt.Axes,
    monthly_category_data: pd.DataFrame,
    diner_meal_mapping: Mapping[pd.Period, float],
    *,
    metric: Metric = KILOS,
    diner_or_meal: DinerOrMeal = "diner",
) -> None:
    """`metric` per diner (or meal) by month, food only against food + drink."""
    title = f"{metric.label} per {diner_or_meal.title()}"
    _draw_multi_series_metric_over_time_on_axis(
        ax,
        _food_and_drink_trends(
            monthly_category_data,
            metric.column,
            per_diner_meal=True,
            diner_meal_mapping=diner_meal_mapping,
        ),
        title=title,
        y_label=title,
    )


def draw_total_emissions(
    ax: plt.Axes,
    monthly_category_data: pd.DataFrame,
) -> None:
    """Total kg CO₂e by month."""
    totals = monthly_totals(monthly_category_data, "emissions_kg_co2e")
    _draw_metric_over_time_on_axis(
        ax,
        pd.DataFrame({"month_year": totals.index, "value": totals.values}),
        title="Total Carbon Emissions Over Time",
        y_label="Total kg CO₂e",
    )


def draw_emissions_per_diner(
    ax: plt.Axes,
    monthly_category_data: pd.DataFrame,
    diner_meal_mapping: Mapping[pd.Period, float],
    *,
    diner_or_meal: DinerOrMeal = "diner",
) -> None:
    """kg CO₂e per diner (or meal) by month."""
    totals = monthly_totals(monthly_category_data, "emissions_kg_co2e")
    per_dm = _per_diner(totals, diner_meal_mapping)
    _draw_metric_over_time_on_axis(
        ax,
        pd.DataFrame({"month_year": per_dm.index, "value": per_dm.values}),
        title=f"Carbon Emissions per {diner_or_meal.title()} Over Time",
        y_label=f"kg CO₂e per {diner_or_meal.title()}",
    )


_PLANT_COLOR = GBD_GREEN
# A warm neutral, so plant stands out as the share that matters. It stays apart from the green
# under protanopia and deuteranopia, which GBD's darker browns do not.
_NON_PLANT_COLOR = "#9A8A76"


def _draw_share_bar_axis(
    ax: plt.Axes,
    share_pct: float,
    *,
    title: str,
    primary_label: str,
    secondary_label: str,
    xlabel: str,
    subtitle: str | None = None,
) -> None:
    """Draw a 100% stacked bar splitting plant from everything else."""
    ax.barh(
        [title],
        [share_pct],
        color=_PLANT_COLOR,
        label=f"{primary_label} ({share_pct:.1f}%)",
    )
    ax.barh(
        [title],
        [100 - share_pct],
        left=[share_pct],
        color=_NON_PLANT_COLOR,
        label=f"{secondary_label} ({100 - share_pct:.1f}%)",
    )
    ax.set_xlim(0, 100)
    ax.set_yticks([])
    ax.set_xlabel(xlabel)
    ax.legend(loc="lower right", fontsize=9)
    if subtitle is None:
        set_title_font(ax, title)
    else:
        # Raise the title to make room for the subtitle beneath it.
        set_title_font(ax, title, pad=20)
        ax.text(
            0.5,
            1.02,
            subtitle,
            transform=ax.transAxes,
            ha="center",
            va="bottom",
            fontsize=10,
            color=GBD_MUTED,
        )
    ax.axvline(50, color=GBD_MUTED, linestyle="--", linewidth=0.8, alpha=0.6)
    add_grid(ax, axis="x")


def _share_axis_top(shares: pd.Series) -> int:
    """A fifth above the highest share, so a month-to-month change is visible, capped at 100%."""
    highest = shares.max()
    if pd.isna(highest) or highest == 0:
        return 100
    return min(100, math.ceil(highest * 1.2))


def _draw_monthly_share_axis(
    ax: plt.Axes,
    monthly: pd.DataFrame,
    *,
    value_column: str,
    title: str,
    y_label: str,
) -> None:
    """Draw a monthly plant share trend."""
    monthly_sorted = monthly.sort_values("month_year").copy()
    x_pos = range(len(monthly_sorted))
    ax.plot(x_pos, monthly_sorted[value_column].values, marker="o", color=_PLANT_COLOR)
    ax.axhline(50, color=GBD_MUTED, linestyle="--", linewidth=0.8, alpha=0.6)
    ax.set_ylim(0, _share_axis_top(monthly_sorted[value_column]))
    ax.set_ylabel(y_label)
    ax.set_xticks(list(x_pos))
    ax.set_xticklabels(format_month_labels(monthly_sorted["month_year"]), rotation=45)
    add_grid(ax)
    set_title_font(ax, title)


def draw_plant_animal_split(
    ax: plt.Axes,
    plant_animal_split: PlantAnimalSplit,
    *,
    metric: Metric = KILOS,
) -> None:
    """Plant-based against animal-based share of the whole period, as one stacked bar."""
    _draw_share_bar_axis(
        ax,
        plant_animal_split.plant_pct,
        title="Plant vs. Animal Split",
        primary_label="Plant-based",
        secondary_label="Animal-based",
        xlabel=f"% of total {metric.label.lower()} (plant + animal categories only)",
        subtitle="Tracked categories only",
    )


def draw_plant_share_by_month(ax: plt.Axes, plant_animal_split: PlantAnimalSplit) -> None:
    """Plant-based share of plant + animal by month."""
    _draw_monthly_share_axis(
        ax,
        plant_animal_split.monthly,
        value_column="plant_pct",
        title="Plant-Based % by Month",
        y_label="% plant-based",
    )


def draw_plant_protein_share(
    ax: plt.Axes,
    plant_protein_share: PlantProteinShare | None,
    *,
    metric: Metric = KILOS,
) -> None:
    """Plant protein against other protein for the whole period, as one stacked bar."""
    title = "Plant Protein Share"
    if plant_protein_share is None:
        _draw_unavailable(ax, title, "Plant protein data was not available.")
        return
    _draw_share_bar_axis(
        ax,
        plant_protein_share.plant_protein_pct,
        title=title,
        primary_label="Plant protein",
        secondary_label="Other protein",
        xlabel=f"% of total {metric.label.lower()} in protein categories",
    )


def draw_plant_protein_share_by_month(
    ax: plt.Axes, plant_protein_share: PlantProteinShare | None
) -> None:
    """Plant protein's share of all protein by month."""
    title = "Plant Protein % by Month"
    if plant_protein_share is None:
        _draw_unavailable(ax, title, "Monthly plant protein data was not available.")
        return
    _draw_monthly_share_axis(
        ax,
        plant_protein_share.monthly,
        value_column="plant_protein_pct",
        title=title,
        y_label="% plant protein",
    )


def draw_category_drivers(
    ax: plt.Axes,
    category_drivers: pd.DataFrame,
    category: str,
    *,
    metric: Metric = KILOS,
) -> None:
    """The products making up most of one category, each as its share of the category."""
    drivers = category_drivers[category_drivers["category"] == category]
    if drivers.empty:
        raise ValueError(f"No drivers for category {category!r}")
    create_horizontal_percentage_barplot(
        ax=ax,
        data=drivers,
        y_col="product",
        percentage_col="percentage",
        add_percentage_labels=False,
    )
    ax.set_xlabel(f"% of category {metric.label.lower()}")
    ax.set_ylabel("")
    set_title_font(ax, standardize_title_case(category), fontsize=12)
