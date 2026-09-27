"""All matplotlib figure generation for food reports."""

from collections.abc import Callable
from typing import Any

import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import pandas as pd
import seaborn as sns
from matplotlib.figure import Figure

from gbd_foodservice_insights.categories import get_drink_categories, get_food_categories
from gbd_foodservice_insights.plotting_utils import (
    GBD_colors,
    add_grid,
    calculate_figure_height_for_wrapped_labels,
    close_new_figures_on_error,
    convert_percentage_to_float,
    create_horizontal_percentage_barplot,
    format_month_labels,
    set_suptitle_font,
    set_title_font,
    set_ylim_with_padding,
    standardize_title_case,
)
from gbd_foodservice_insights.report.quality import make_finding
from gbd_foodservice_insights.report.schema import metric_display_label, per_diner_metric_name
from gbd_foodservice_insights.report.utils import divide_by_diner_meals, monthly_totals


def _placeholder_figure(title: str, message: str) -> Figure:
    """Create a placeholder figure when a plot cannot be generated."""
    fig, ax = plt.subplots(figsize=(10, 4))
    ax.axis("off")
    ax.text(0.5, 0.72, title, ha="center", va="center", fontsize=14, fontweight="bold")
    ax.text(0.5, 0.42, message, ha="center", va="center", fontsize=11, wrap=True)
    return fig


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


def plot_diner_meal_numbers(
    diner_meal_mapping: dict[Any, Any] | pd.Series,
    diner_or_meal: str = "diner",
) -> Figure:
    """Line graph of diner-meal counts per month."""
    if isinstance(diner_meal_mapping, dict):
        diner_meal_series = pd.Series(diner_meal_mapping).sort_index()
    else:
        diner_meal_series = pd.Series(diner_meal_mapping).sort_index()

    fig, ax = plt.subplots(figsize=(6, 4))
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

        fig_height = calculate_figure_height_for_wrapped_labels(
            data["product"].tolist(),
            max_width=max_label_width,
            base_height=3.0,
            height_per_item=0.3,
        )

        fig, ax = plt.subplots(figsize=(8, fig_height))
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
    fig_height = calculate_figure_height_for_wrapped_labels(
        overall_drivers["product"].tolist(),
        max_width=max_label_width,
        base_height=4.0,
        height_per_item=0.35,
    )

    fig, ax = plt.subplots(figsize=(10, fig_height))
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

    fig, ax = plt.subplots(figsize=(12, 6))
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


def _filter_monthly_categories_by_type(
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
        subset = _filter_monthly_categories_by_type(
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


def plot_food_and_drink_comparison_page(
    monthly_category_data: pd.DataFrame,
    *,
    metric: str = "kilos_total",
    diner_meal_mapping: dict[Any, Any] | None = None,
    diner_or_meal: str = "diner",
    figsize: tuple[int, int] = (14, 5),
) -> Figure:
    """Create one page with total and per-diner trends, each comparing food vs food + drink."""
    if diner_meal_mapping is None:
        raise ValueError("diner_meal_mapping is required for the comparison page")

    fig, axes = plt.subplots(1, 2, figsize=figsize)
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

    fig, ax = plt.subplots(figsize=(10, max(4, len(data) * 0.4)))
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


def plot_emissions_summary_over_time(
    monthly_category_data: pd.DataFrame,
    diner_meal_mapping: dict[Any, Any],
    emissions_col: str = "emissions_kg_co2e",
    diner_or_meal: str = "diner",
    figsize: tuple[float, float] = (12, 4.8),
) -> Figure:
    """Put total and per-diner emissions trends together on one report page."""
    fig, axes = plt.subplots(1, 2, figsize=figsize)
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


def plot_plant_breakdown_overview(
    plant_animal_split: dict[str, Any] | None,
    plant_protein_share: dict[str, Any] | None,
    metric_label: str = "Kilos",
) -> Figure:
    """Combine the plant and protein share visuals into a single four-panel page."""
    fig, axes = plt.subplots(2, 2, figsize=(13, 7.6))
    set_suptitle_font(fig, "Plant and Protein Breakdown", fontsize=16)
    draw_plant_animal_split(axes[0, 0], plant_animal_split, metric_label=metric_label)
    draw_plant_share_by_month(axes[0, 1], plant_animal_split)
    draw_plant_protein_share(axes[1, 0], plant_protein_share, metric_label=metric_label)
    draw_plant_protein_share_by_month(axes[1, 1], plant_protein_share)
    fig.tight_layout(rect=(0, 0, 1, 0.93))
    return fig


def _safe_plot(
    *,
    caption: str,
    plot_fn: Callable[..., Figure],
    quality_findings: list[dict[str, Any]],
    warning_message: str,
    warning_stage: str = "plots",
    input_checks: list[tuple[pd.DataFrame, str]] | None = None,
) -> tuple[str, Figure]:
    """Generate plot and fallback to placeholder with finding on failure."""
    has_input_warning = False
    for df, column in input_checks or []:
        if column not in df.columns:
            quality_findings.append(
                make_finding(
                    stage=warning_stage,
                    category="plot_input_missing_column",
                    status="warning",
                    message=(
                        f"Plot '{caption}' cannot validate '{column}' because the column is "
                        "missing."
                    ),
                    column=column,
                )
            )
            has_input_warning = True
            continue

        missing_count = int(df[column].isna().sum())
        if missing_count > 0:
            quality_findings.append(
                make_finding(
                    stage=warning_stage,
                    category="plot_input_missing_values",
                    status="warning",
                    message=(
                        f"Plot '{caption}' input column '{column}' contains {missing_count} "
                        "missing values."
                    ),
                    column=column,
                    count=missing_count,
                )
            )
            has_input_warning = True

    output_caption = f"{caption} [DATA WARNING]" if has_input_warning else caption

    try:
        with close_new_figures_on_error():
            fig = _remove_duplicate_xlabels(plot_fn())
            if has_input_warning:
                fig.suptitle(output_caption, fontsize=10, color="#b22222", y=0.99)
        return output_caption, fig
    except Exception as exc:
        quality_findings.append(
            make_finding(
                stage=warning_stage,
                category="plot_generation",
                status="warning",
                message=f"{warning_message}: {exc}",
            )
        )
        fallback_fig = _placeholder_figure(
            caption,
            f"Could not generate plot due to data issue:\n{exc}",
        )
        fallback_fig.suptitle(
            f"{caption} [DATA WARNING]",
            fontsize=10,
            color="#b22222",
            y=0.99,
        )
        return (
            f"{caption} [DATA WARNING]",
            fallback_fig,
        )


def generate_all_report_plots(
    aggregated_data: dict[str, Any],
    diner_meal_mapping: dict[Any, Any],
    emissions_summary: pd.DataFrame | None = None,
    metric_total: str = "kilos_total",
    serving: bool = False,
    quality_findings: list[dict[str, Any]] | None = None,
    plant_animal_split: dict[str, Any] | None = None,
    plant_protein_share: dict[str, Any] | None = None,
    diner_or_meal: str = "diner",
) -> list[tuple[str, Figure]]:
    """Generate all report plots and return ``(caption, figure)`` tuples."""
    findings = quality_findings if quality_findings is not None else []
    plots: list[tuple[str, Figure]] = []

    monthly_cat = aggregated_data.get("monthly_category_data", pd.DataFrame())
    overall_drivers = aggregated_data.get("overall_drivers", pd.DataFrame())
    category_drivers = aggregated_data.get("category_drivers", pd.DataFrame())

    if not monthly_cat.empty:
        _filter_monthly_categories_by_type(monthly_cat, include_drinks=True)

    metric_label = metric_display_label(metric_total)

    plots.append(
        (
            "",
            _safe_plot(
                caption=f"{diner_or_meal.title()}s by Month",
                plot_fn=lambda: plot_diner_meal_numbers(diner_meal_mapping, diner_or_meal),
                quality_findings=findings,
                warning_message=f"Could not plot {diner_or_meal} numbers",
            )[1],
        )
    )

    plots.append(
        (
            "",
            _safe_plot(
                caption=f"{metric_label} Over Time: Food vs Food + Drink",
                plot_fn=lambda: plot_food_and_drink_comparison_page(
                    monthly_cat,
                    metric=metric_total,
                    diner_meal_mapping=diner_meal_mapping,
                    diner_or_meal=diner_or_meal,
                ),
                quality_findings=findings,
                warning_message="Could not plot food versus food-and-drink trends over time",
                input_checks=[(monthly_cat, "month_year"), (monthly_cat, metric_total)],
            )[1],
        )
    )

    plots.append(
        (
            "",
            _safe_plot(
                caption=f"{metric_label} by Category",
                plot_fn=lambda: plot_category_totals(monthly_cat, metric_total),
                quality_findings=findings,
                warning_message="Could not plot category totals",
                input_checks=[(monthly_cat, "category"), (monthly_cat, metric_total)],
            )[1],
        )
    )

    if emissions_summary is not None and not serving:
        plots.append(
            (
                "",
                _safe_plot(
                    caption="Carbon Emissions by Category",
                    plot_fn=lambda: plot_emissions_by_category(emissions_summary),
                    quality_findings=findings,
                    warning_message="Could not plot emissions by category",
                    input_checks=[
                        (emissions_summary, "category"),
                        (emissions_summary, "total_kg_co2e"),
                    ],
                )[1],
            )
        )

        if "emissions_kg_co2e" in monthly_cat.columns:
            plots.append(
                (
                    "",
                    _safe_plot(
                        caption=(
                            f"Carbon Emissions Over Time: Total and per {diner_or_meal.title()}"
                        ),
                        plot_fn=lambda: plot_emissions_summary_over_time(
                            monthly_cat,
                            diner_meal_mapping,
                            diner_or_meal=diner_or_meal,
                        ),
                        quality_findings=findings,
                        warning_message="Could not plot combined emissions trends over time",
                        input_checks=[
                            (monthly_cat, "month_year"),
                            (monthly_cat, "emissions_kg_co2e"),
                        ],
                    )[1],
                )
            )

    if plant_animal_split is not None or plant_protein_share is not None:
        plots.append(
            (
                "",
                _safe_plot(
                    caption="Plant and Protein Breakdown",
                    plot_fn=lambda: plot_plant_breakdown_overview(
                        plant_animal_split,
                        plant_protein_share,
                        metric_label=metric_label,
                    ),
                    quality_findings=findings,
                    warning_message="Could not plot plant and protein breakdown",
                )[1],
            )
        )

    plots.append(
        (
            "",
            _safe_plot(
                caption="Top Products Overall",
                plot_fn=lambda: plot_overall_drivers(overall_drivers, metric_total),
                quality_findings=findings,
                warning_message="Could not plot overall drivers",
                input_checks=[(overall_drivers, "product"), (overall_drivers, "percentage")],
            )[1],
        )
    )

    try:
        has_input_warning = False
        for required_col in ("category", "product", "percentage"):
            if required_col not in category_drivers.columns:
                findings.append(
                    make_finding(
                        stage="plots",
                        category="plot_input_missing_column",
                        status="warning",
                        message=(
                            "Category-driver plots are missing required input column "
                            f"'{required_col}'."
                        ),
                        column=required_col,
                    )
                )
                has_input_warning = True
                continue

            missing_count = int(category_drivers[required_col].isna().sum())
            if missing_count > 0:
                findings.append(
                    make_finding(
                        stage="plots",
                        category="plot_input_missing_values",
                        status="warning",
                        message=(
                            f"Category-driver plots input column '{required_col}' contains "
                            f"{missing_count} missing values."
                        ),
                        column=required_col,
                        count=missing_count,
                    )
                )
                has_input_warning = True

        # All or nothing: on a failure, the placeholder below replaces every category's chart.
        category_plots: list[tuple[str, Figure]] = []
        with close_new_figures_on_error():
            cat_figs = plot_category_drivers(category_drivers, metric=metric_total)
            for cat_name, fig in cat_figs.items():
                fig = _remove_duplicate_xlabels(fig)
                caption = f"Top Products — {standardize_title_case(cat_name)}"
                if has_input_warning:
                    caption += " [DATA WARNING]"
                    fig.suptitle(caption, fontsize=10, color="#b22222", y=0.99)
                category_plots.append(("", fig))
        plots.extend(category_plots)
    except Exception as exc:
        findings.append(
            make_finding(
                stage="plots",
                category="plot_generation",
                status="warning",
                message=f"Could not generate category-driver plots: {exc}",
            )
        )
        plots.append(
            (
                "",
                _placeholder_figure(
                    "Top Products by Category",
                    f"Could not generate category-driver plots due to data issue:\n{exc}",
                ),
            )
        )

    return plots
