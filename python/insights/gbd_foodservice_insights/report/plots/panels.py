"""Chart panels: each `draw_*` fills an `Axes` it is handed, empty state included."""

from typing import Any

import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import pandas as pd

from gbd_foodservice_insights.categories import get_drink_categories, get_food_categories
from gbd_foodservice_insights.plotting_utils import (
    GBD_colors,
    add_grid,
    format_month_labels,
    set_title_font,
)
from gbd_foodservice_insights.report.schema import metric_display_label, per_diner_metric_name
from gbd_foodservice_insights.report.utils import divide_by_diner_meals, monthly_totals


def prepare_monthly_trend_data(
    monthly_category_data: pd.DataFrame,
    metric: str,
    *,
    per_diner_meal: bool,
    diner_meal_mapping: dict[Any, Any] | None,
) -> tuple[pd.DataFrame, str]:
    """Prepare canonical monthly trend table for plotting."""
    totals = monthly_totals(monthly_category_data, metric, month_col="month_year")

    if per_diner_meal:
        if diner_meal_mapping is None:
            raise ValueError("diner_meal_mapping is required when per_diner_meal=True")
        values, _, _ = divide_by_diner_meals(
            totals,
            diner_meal_mapping,
            strict=False,
        )
        metric_label = per_diner_metric_name(metric)
    else:
        values = totals
        metric_label = "Total " + metric_display_label(metric)

    plot_data = pd.DataFrame({"month_year": values.index, "value": values.values})
    return plot_data, metric_label


def filter_monthly_categories_by_type(
    monthly_category_data: pd.DataFrame,
    *,
    include_drinks: bool,
) -> pd.DataFrame:
    """Filter monthly category data to food only or food + drink categories."""
    if "category" not in monthly_category_data.columns:
        return monthly_category_data.iloc[0:0].copy()

    food_categories = set(get_food_categories(lowercase=True))
    drink_categories = set(get_drink_categories(lowercase=True))
    known_categories = food_categories | drink_categories

    filtered = monthly_category_data.copy()
    filtered["_category_lower"] = filtered["category"].astype(str).str.strip().str.lower()

    unknown_categories = sorted(
        str(category).strip()
        for category in filtered.loc[
            filtered["_category_lower"].notna()
            & ~filtered["_category_lower"].isin(known_categories),
            "category",
        ]
        .dropna()
        .unique()
    )
    if unknown_categories:
        raise ValueError(
            "All monthly categories must be tagged as food or drink before plotting. "
            f"Unknown categories: {unknown_categories}"
        )

    categories = set(food_categories)
    if include_drinks:
        categories.update(drink_categories)

    filtered = filtered[filtered["_category_lower"].isin(categories)].copy()
    return filtered.drop(columns="_category_lower")


def _draw_unavailable(ax: plt.Axes, title: str, message: str) -> None:
    """Stand in for a panel whose data is missing, keeping its title."""
    ax.axis("off")
    ax.text(0.5, 0.6, title, ha="center", va="center", fontsize=12, fontweight="bold")
    ax.text(0.5, 0.42, message, ha="center", va="center", fontsize=10, color="gray")


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
        color=GBD_colors[0] if GBD_colors else None,
    )
    ax.set_xticks(x_positions)
    ax.set_xticklabels(format_month_labels(data_sorted["month_year"]), rotation=45)
    ax.set_ylabel(y_label)
    set_title_font(ax, title)
    add_grid(ax)


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
            color="gray",
        )
        return

    month_order = pd.Index([])
    for _, plot_data in non_empty_payloads:
        month_order = month_order.union(pd.Index(plot_data["month_year"]))
    month_order = month_order.sort_values()
    x_positions = list(range(len(month_order)))
    month_to_x = {month: idx for idx, month in enumerate(month_order)}

    for idx, (label, plot_data) in enumerate(non_empty_payloads):
        color = GBD_colors[idx % len(GBD_colors)] if GBD_colors else None
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

    y_max = max(
        (
            float(max_value)
            for _, plot_data in non_empty_payloads
            if pd.notna(max_value := pd.to_numeric(plot_data["value"], errors="coerce").max())
        ),
        default=0.0,
    )
    if y_max > 0:
        ax.set_ylim(0, y_max * 1.2)
    elif y_max == 0:
        ax.set_ylim(0, 1)


def _food_and_drink_trends(
    monthly_category_data: pd.DataFrame,
    metric: str,
    *,
    per_diner_meal: bool,
    diner_meal_mapping: dict[Any, Any] | None = None,
) -> list[tuple[str, pd.DataFrame]]:
    """Monthly trends of `metric` for food only and for food + drink, as labelled series."""
    if metric not in {"kilos_total", "servings total"}:
        raise ValueError("metric must be 'kilos_total' or 'servings total'")

    def trend(*, include_drinks: bool) -> pd.DataFrame:
        subset = filter_monthly_categories_by_type(
            monthly_category_data, include_drinks=include_drinks
        )
        if subset.empty:
            return pd.DataFrame(columns=["month_year", "value"])
        plot_data, _ = prepare_monthly_trend_data(
            subset,
            metric,
            per_diner_meal=per_diner_meal,
            diner_meal_mapping=diner_meal_mapping,
        )
        return plot_data

    return [
        ("Food Only", trend(include_drinks=False)),
        ("Food + Drink", trend(include_drinks=True)),
    ]


def draw_food_and_drink_totals(
    ax: plt.Axes,
    monthly_category_data: pd.DataFrame,
    *,
    metric: str = "kilos_total",
) -> None:
    """Total `metric` by month, food only against food + drink."""
    title = f"Total {metric_display_label(metric)}"
    _draw_multi_series_metric_over_time_on_axis(
        ax,
        _food_and_drink_trends(monthly_category_data, metric, per_diner_meal=False),
        title=title,
        y_label=title,
    )


def draw_food_and_drink_per_diner(
    ax: plt.Axes,
    monthly_category_data: pd.DataFrame,
    diner_meal_mapping: dict[Any, Any],
    *,
    metric: str = "kilos_total",
    diner_or_meal: str = "diner",
) -> None:
    """`metric` per diner (or meal) by month, food only against food + drink."""
    title = f"{metric_display_label(metric)} per {diner_or_meal.title()}"
    _draw_multi_series_metric_over_time_on_axis(
        ax,
        _food_and_drink_trends(
            monthly_category_data,
            metric,
            per_diner_meal=True,
            diner_meal_mapping=diner_meal_mapping,
        ),
        title=title,
        y_label=title,
    )


def _format_with_magnitude_suffix(x: float, _pos: int | None) -> str:
    if abs(x) >= 1e6:
        return f"{x / 1e6:,.1f}M"
    if abs(x) >= 1e3:
        return f"{x / 1e3:,.0f}k"
    return f"{x:,.0f}"


def draw_total_emissions(
    ax: plt.Axes,
    monthly_category_data: pd.DataFrame,
    *,
    emissions_col: str = "emissions_kg_co2e",
) -> None:
    """Total kg CO2e by month."""
    totals = monthly_totals(monthly_category_data, emissions_col)
    _draw_metric_over_time_on_axis(
        ax,
        pd.DataFrame({"month_year": totals.index, "value": totals.values}),
        title="Total Carbon Emissions Over Time",
        y_label="Total kg CO₂e",
    )
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(_format_with_magnitude_suffix))


def draw_emissions_per_diner(
    ax: plt.Axes,
    monthly_category_data: pd.DataFrame,
    diner_meal_mapping: dict[Any, Any],
    *,
    emissions_col: str = "emissions_kg_co2e",
    diner_or_meal: str = "diner",
) -> None:
    """kg CO2e per diner (or meal) by month."""
    totals = monthly_totals(monthly_category_data, emissions_col)
    per_dm, _, _ = divide_by_diner_meals(totals, diner_meal_mapping, strict=False)
    _draw_metric_over_time_on_axis(
        ax,
        pd.DataFrame({"month_year": per_dm.index, "value": per_dm.values}),
        title=f"Carbon Emissions per {diner_or_meal.title()} Over Time",
        y_label=f"kg CO2e per {diner_or_meal.title()}",
    )


_PLANT_COLOR = GBD_colors[2]
_NON_PLANT_COLOR = GBD_colors[0]


def _draw_share_bar_axis(
    ax: plt.Axes,
    share_pct: float,
    *,
    title: str,
    primary_label: str,
    secondary_label: str,
    xlabel: str,
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
    set_title_font(ax, title)
    ax.axvline(50, color="gray", linestyle="--", linewidth=0.8, alpha=0.6)
    add_grid(ax, axis="x")


def _draw_monthly_share_axis(
    ax: plt.Axes,
    monthly: pd.DataFrame | None,
    *,
    value_column: str,
    title: str,
    y_label: str,
    empty_message: str,
) -> None:
    """Draw a monthly plant share trend, or the unavailable state without one."""
    if (
        monthly is None
        or monthly.empty
        or "month_year" not in monthly.columns
        or value_column not in monthly.columns
    ):
        _draw_unavailable(ax, title, empty_message)
        return

    monthly_sorted = monthly.sort_values("month_year").copy()
    x_pos = range(len(monthly_sorted))
    ax.plot(x_pos, monthly_sorted[value_column].values, marker="o", color=_PLANT_COLOR)
    ax.axhline(50, color="gray", linestyle="--", linewidth=0.8, alpha=0.6)
    ax.set_ylim(0, 100)
    ax.set_ylabel(y_label)
    ax.set_xticks(list(x_pos))
    ax.set_xticklabels(format_month_labels(monthly_sorted["month_year"]), rotation=45)
    add_grid(ax)
    set_title_font(ax, title)


def draw_plant_animal_split(
    ax: plt.Axes,
    plant_animal_split: dict[str, Any] | None,
    *,
    metric_label: str = "Kilos",
) -> None:
    """Plant-based against animal-based share of the whole period, as one stacked bar."""
    title = "Plant vs. Animal Split"
    if plant_animal_split is None:
        _draw_unavailable(ax, title, "Plant/animal data was not available.")
        return
    _draw_share_bar_axis(
        ax,
        float(plant_animal_split["plant_pct"]),
        title=title,
        primary_label="Plant-based",
        secondary_label="Animal-based",
        xlabel=f"% of total {metric_label.lower()} (plant + animal categories only)",
    )


def draw_plant_share_by_month(ax: plt.Axes, plant_animal_split: dict[str, Any] | None) -> None:
    """Plant-based share of plant + animal by month."""
    _draw_monthly_share_axis(
        ax,
        plant_animal_split.get("monthly") if plant_animal_split else None,
        value_column="plant_pct",
        title="Plant-Based % by Month",
        y_label="% plant-based",
        empty_message="Monthly plant/animal data was not available.",
    )


def draw_plant_protein_share(
    ax: plt.Axes,
    plant_protein_share: dict[str, Any] | None,
    *,
    metric_label: str = "Kilos",
) -> None:
    """Plant protein against other protein for the whole period, as one stacked bar."""
    title = "Plant Protein Share"
    if plant_protein_share is None:
        _draw_unavailable(ax, title, "Plant protein data was not available.")
        return
    _draw_share_bar_axis(
        ax,
        float(plant_protein_share["plant_protein_pct"]),
        title=title,
        primary_label="Plant protein",
        secondary_label="Other protein",
        xlabel=f"% of total {metric_label.lower()} in protein categories",
    )


def draw_plant_protein_share_by_month(
    ax: plt.Axes, plant_protein_share: dict[str, Any] | None
) -> None:
    """Plant protein's share of all protein by month."""
    _draw_monthly_share_axis(
        ax,
        plant_protein_share.get("monthly") if plant_protein_share else None,
        value_column="plant_protein_pct",
        title="Plant Protein % by Month",
        y_label="% plant protein",
        empty_message="Monthly plant protein data was not available.",
    )
