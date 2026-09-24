"""All matplotlib figure generation for food reports."""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import numpy as np
import pandas as pd
import seaborn as sns
from matplotlib.figure import Figure

from gbd_foodservice_insights.categories import get_drink_categories, get_food_categories
from gbd_foodservice_insights.plotting_utils import (
    GBD_colors,
    add_grid,
    calculate_figure_height_for_wrapped_labels,
    convert_percentage_to_float,
    create_horizontal_percentage_barplot,
    format_month_labels,
    plot_time_series_with_periods,
    rotate_x_labels,
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


def _slugify_plot_label(value: str) -> str:
    """Convert plot labels into filesystem-safe filename stems."""
    collapsed = re.sub(r"\s+", " ", str(value)).strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "_", collapsed).strip("_")
    return slug[:80] or "plot"


def _figure_export_label(fig: Figure) -> str:
    """Return the best available human-readable label for a figure."""
    suptitle = getattr(fig, "_suptitle", None)
    if suptitle is not None:
        text = suptitle.get_text().strip()
        if text:
            return text

    for ax in fig.axes:
        title = ax.get_title().strip()
        if title:
            return title

    return ""


def export_report_plots(
    plots: list[tuple[str, Figure]],
    output_dir: str | Path,
    *,
    image_format: str = "png",
    dpi: int = 300,
) -> list[str]:
    """Save report plots as image files and return their absolute paths."""
    export_dir = Path(output_dir).resolve()
    export_dir.mkdir(parents=True, exist_ok=True)

    used_names: dict[str, int] = {}
    saved_paths: list[str] = []

    for index, (caption, fig) in enumerate(plots, start=1):
        base_label = caption.strip() or _figure_export_label(fig) or f"plot_{index:02d}"
        base_name = _slugify_plot_label(base_label)
        duplicate_count = used_names.get(base_name, 0) + 1
        used_names[base_name] = duplicate_count
        if duplicate_count > 1:
            base_name = f"{base_name}_{duplicate_count:02d}"

        output_path = export_dir / f"{index:02d}_{base_name}.{image_format}"
        fig.savefig(output_path, dpi=dpi, bbox_inches="tight")
        saved_paths.append(str(output_path.resolve()))

    return saved_paths


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


def _prepare_monthly_trend_data(
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


def _numeric_columns_for_profile(df: pd.DataFrame) -> list[str]:
    """Return numeric columns excluding known non-metric helper columns."""
    numeric_columns = df.select_dtypes(include=[np.number]).columns.tolist()
    return [column for column in numeric_columns if column.lower() != "page"]


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


def plot_metric_over_time(
    monthly_category_data: pd.DataFrame,
    metric: str = "kilos_total",
    per_diner_meal: bool = False,
    diner_meal_mapping: dict[Any, Any] | None = None,
    custom_title: str | None = None,
    figsize: tuple[int, int] = (10, 5),
) -> Figure:
    """Line graph of total or per-diner metric over time."""
    if metric not in {"kilos_total", "servings total"}:
        raise ValueError("metric must be 'kilos_total' or 'servings total'")

    plot_data, metric_label = _prepare_monthly_trend_data(
        monthly_category_data,
        metric,
        per_diner_meal=per_diner_meal,
        diner_meal_mapping=diner_meal_mapping,
    )

    plot_title = custom_title or f"{metric_label.title()} Over Time"
    fig = plot_time_series_with_periods(
        data=plot_data,
        y_col="value",
        y_label=metric_label.title(),
        title=plot_title,
        figsize=figsize,
        ylim_padding_factor=0.2,
        use_period_hue=False,
    )

    # Add a note if month-to-month variation is large (coefficient of variation > 25%)
    if "value" in plot_data.columns and len(plot_data) > 1:
        vals = plot_data["value"].dropna()
        mean_val = vals.mean()
        if mean_val > 0 and (vals.std() / mean_val) > 0.25:
            fig.text(
                0.5,
                0.01,
                (
                    "Note: month-to-month variation is normal and may reflect seasonal menus, "
                    "catering events, or changes in diner numbers."
                ),
                ha="center",
                va="bottom",
                fontsize=8,
                color="gray",
                style="italic",
            )

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


def _draw_metric_over_time_on_axis(
    ax: plt.Axes,
    plot_data: pd.DataFrame,
    *,
    title: str,
    y_label: str,
    y_max: float | None = None,
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

    if y_max is not None and y_max > 0:
        ax.set_ylim(0, y_max * 1.2)
    elif y_max == 0:
        ax.set_ylim(0, 1)


def _draw_multi_series_metric_over_time_on_axis(
    ax: plt.Axes,
    series_payloads: list[tuple[str, pd.DataFrame]],
    *,
    title: str,
    y_label: str,
    y_max: float | None = None,
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

    if y_max is not None and y_max > 0:
        ax.set_ylim(0, y_max * 1.2)
    elif y_max == 0:
        ax.set_ylim(0, 1)


def plot_food_vs_food_and_drink_over_time(
    monthly_category_data: pd.DataFrame,
    *,
    metric: str = "kilos_total",
    per_diner_meal: bool = False,
    diner_meal_mapping: dict[Any, Any] | None = None,
    diner_or_meal: str = "diner",
    figsize: tuple[int, int] = (14, 5),
) -> Figure:
    """Create side-by-side monthly trends for food only vs food + drink."""
    if metric not in {"kilos_total", "servings total"}:
        raise ValueError("metric must be 'kilos_total' or 'servings total'")

    metric_title = (
        f"{metric_display_label(metric)} per {diner_or_meal.title()}"
        if per_diner_meal
        else f"Total {metric_display_label(metric)}"
    )

    subsets = [
        (
            "Food Only",
            _filter_monthly_categories_by_type(monthly_category_data, include_drinks=False),
        ),
        (
            "Food + Drink",
            _filter_monthly_categories_by_type(monthly_category_data, include_drinks=True),
        ),
    ]

    prepared: list[tuple[str, pd.DataFrame]] = []
    for subset_title, subset_df in subsets:
        if subset_df.empty:
            prepared.append((subset_title, pd.DataFrame(columns=["month_year", "value"])))
            continue
        plot_data, _ = _prepare_monthly_trend_data(
            subset_df,
            metric,
            per_diner_meal=per_diner_meal,
            diner_meal_mapping=diner_meal_mapping,
        )
        prepared.append((subset_title, plot_data))

    max_value = 0.0
    for _, plot_data in prepared:
        if "value" in plot_data.columns and not plot_data.empty:
            candidate = pd.to_numeric(plot_data["value"], errors="coerce").max()
            if pd.notna(candidate):
                max_value = max(max_value, float(candidate))

    fig, axes = plt.subplots(1, 2, figsize=figsize, sharey=True)
    set_suptitle_font(fig, f"{metric_title} Over Time", fontsize=16)

    for ax, (subset_title, plot_data) in zip(axes, prepared, strict=True):
        if plot_data.empty:
            ax.axis("off")
            ax.text(
                0.5,
                0.6,
                subset_title,
                ha="center",
                va="center",
                fontsize=14,
                fontweight="bold",
            )
            ax.text(
                0.5,
                0.42,
                "No matching category data available.",
                ha="center",
                va="center",
                fontsize=10,
                color="gray",
            )
            continue

        _draw_metric_over_time_on_axis(
            ax,
            plot_data,
            title=subset_title,
            y_label=metric_title,
            y_max=max_value,
        )

    fig.tight_layout(rect=(0, 0, 1, 0.94))
    return fig


def plot_food_and_drink_comparison_page(
    monthly_category_data: pd.DataFrame,
    *,
    metric: str = "kilos_total",
    diner_meal_mapping: dict[Any, Any] | None = None,
    diner_or_meal: str = "diner",
    figsize: tuple[int, int] = (14, 5),
) -> Figure:
    """Create one page with total and per-diner trends, each comparing food vs food + drink."""
    if metric not in {"kilos_total", "servings total"}:
        raise ValueError("metric must be 'kilos_total' or 'servings total'")
    if diner_meal_mapping is None:
        raise ValueError("diner_meal_mapping is required for the comparison page")

    food_only = _filter_monthly_categories_by_type(monthly_category_data, include_drinks=False)
    food_and_drink = _filter_monthly_categories_by_type(monthly_category_data, include_drinks=True)

    def _prepare_series(subset_df: pd.DataFrame, *, per_diner: bool) -> pd.DataFrame:
        if subset_df.empty:
            return pd.DataFrame(columns=["month_year", "value"])
        plot_data, _ = _prepare_monthly_trend_data(
            subset_df,
            metric,
            per_diner_meal=per_diner,
            diner_meal_mapping=diner_meal_mapping,
        )
        return plot_data

    total_payloads = [
        ("Food Only", _prepare_series(food_only, per_diner=False)),
        ("Food + Drink", _prepare_series(food_and_drink, per_diner=False)),
    ]
    per_diner_payloads = [
        ("Food Only", _prepare_series(food_only, per_diner=True)),
        ("Food + Drink", _prepare_series(food_and_drink, per_diner=True)),
    ]

    def _max_value(payloads: list[tuple[str, pd.DataFrame]]) -> float:
        candidates = [
            float(pd.to_numeric(plot_data["value"], errors="coerce").max())
            for _, plot_data in payloads
            if not plot_data.empty
            and "value" in plot_data.columns
            and pd.notna(pd.to_numeric(plot_data["value"], errors="coerce").max())
        ]
        return max(candidates, default=0.0)

    total_title = f"Total {metric_display_label(metric)}"
    per_diner_title = f"{metric_display_label(metric)} per {diner_or_meal.title()}"

    fig, axes = plt.subplots(1, 2, figsize=figsize)
    set_suptitle_font(fig, f"{metric_display_label(metric)} Over Time", fontsize=16)

    _draw_multi_series_metric_over_time_on_axis(
        axes[0],
        total_payloads,
        title=total_title,
        y_label=total_title,
        y_max=_max_value(total_payloads),
    )
    _draw_multi_series_metric_over_time_on_axis(
        axes[1],
        per_diner_payloads,
        title=per_diner_title,
        y_label=per_diner_title,
        y_max=_max_value(per_diner_payloads),
    )

    fig.tight_layout(rect=(0, 0, 1, 0.94))
    return fig


def plot_date_value_counts(
    df: pd.DataFrame,
    fig_size: tuple[int, int] = (8, 4),
) -> Figure:
    """Plot row counts per date."""
    _df = df.copy()
    if "date" not in _df.columns:
        return _placeholder_figure("Date Value Counts", "Missing 'date' column.")

    _df["date"] = pd.to_datetime(_df["date"], errors="coerce")
    date_counts = _df["date"].value_counts(dropna=False).sort_index()

    fig, ax = plt.subplots(figsize=fig_size)
    x_data = date_counts.index.to_numpy()
    y_data = date_counts.to_numpy()
    ax.plot(x_data, y_data, "-", linewidth=2)
    ax.scatter(x_data, y_data, s=50, zorder=2)
    ax.set_title("Date Value Counts")
    ax.set_xlabel("Date")
    if len(date_counts) > 0:
        ax.set_ylim(0, date_counts.max() * 1.1)
    ax.set_ylabel("Counts")
    ax.tick_params(axis="x", rotation=45)
    plt.tight_layout()
    return fig


def plot_metric_by_date(
    df: pd.DataFrame,
    metric_column: str,
    fig_size: tuple[int, int] = (8, 8),
) -> Figure:
    """Mean/median/sum subplots of a metric grouped by date."""
    _df = df.copy()
    _df["date"] = pd.to_datetime(_df["date"], errors="coerce")

    grouped_mean = _df.groupby("date", dropna=False)[metric_column].mean().reset_index()
    grouped_median = _df.groupby("date", dropna=False)[metric_column].median().reset_index()
    grouped_sum = _df.groupby("date", dropna=False)[metric_column].sum(min_count=1).reset_index()

    fig, axs = plt.subplots(3, figsize=fig_size)

    for idx, (grouped, stat) in enumerate(
        [(grouped_mean, "Mean"), (grouped_median, "Median"), (grouped_sum, "Sum")]
    ):
        color = GBD_colors[idx]
        sns.lineplot(
            data=grouped,
            x="date",
            y=metric_column,
            ax=axs[idx],
            linewidth=2,
            color=color,
        )
        sns.scatterplot(
            data=grouped,
            x="date",
            y=metric_column,
            ax=axs[idx],
            s=50,
            color=color,
            zorder=3,
        )
        axs[idx].set_title(f"{stat} {metric_column} by date")
        rotate_x_labels(axs[idx])

    plt.tight_layout()
    return fig


def plot_metrics_by_date(df: pd.DataFrame) -> list[Figure]:
    """Plot date-level metrics for all numeric columns."""
    figs = []
    for metric_column in _numeric_columns_for_profile(df):
        figs.append(plot_metric_by_date(df, metric_column))
    return figs


def plot_category_distribution(df: pd.DataFrame, client_name: str | None = None) -> Figure:
    """Horizontal bar chart of row distribution by category."""
    if "category" not in df.columns:
        return _placeholder_figure("Category Distribution", "Missing 'category' column.")

    category_counts = df["category"].value_counts(dropna=False).reset_index()
    category_counts.columns = ["Category", "Count"]
    category_counts = category_counts.sort_values("Count", ascending=False)

    fig, ax = plt.subplots(figsize=(14, 8))
    sns.set_style("whitegrid")
    sns.barplot(x="Count", y="Category", data=category_counts, ax=ax)

    title = "Distribution of Food Categories"
    if client_name:
        title = f"Distribution of Food Categories in {client_name}".replace("_", " ").title()
    ax.set_title(title, fontsize=16)
    ax.set_xlabel("Number of Rows in Data", fontsize=12)
    ax.set_ylabel("", fontsize=12)

    for i, value in enumerate(category_counts["Count"]):
        ax.text(value * 1.01, i, str(value), va="center")

    fig.tight_layout()
    return fig


def plot_metric_by_month(
    df: pd.DataFrame,
    metric_column: str,
    fig_size: tuple[int, int] = (12, 4),
) -> Figure:
    """Mean/median/sum of metric grouped by month."""
    df_copy = df.copy()
    df_copy["date"] = pd.to_datetime(df_copy["date"], errors="coerce").dt.strftime("%Y-%m")
    grouped = (
        df_copy.groupby("date", dropna=False)[metric_column]
        .agg(["mean", "median", "sum"])
        .reset_index()
    )

    fig, axes = plt.subplots(1, 3, figsize=fig_size)
    for idx, (stat, color) in enumerate(
        [("mean", GBD_colors[0]), ("median", GBD_colors[1]), ("sum", GBD_colors[2])]
    ):
        grouped.plot(x="date", y=stat, kind="line", ax=axes[idx], color=color, legend=False)
        axes[idx].set_title(f"{stat.title()} {metric_column} by month")
        axes[idx].set_xlabel("")
        axes[idx].set_ylabel("")
        rotate_x_labels(axes[idx])

    plt.tight_layout()
    return fig


def plot_metrics_by_month(
    df: pd.DataFrame,
    product_name_col: str | None = None,
) -> list[Figure]:
    """Plot month-level metric profiles for numeric columns."""
    _df = df.copy()
    figs: list[Figure] = []

    if product_name_col and product_name_col in _df.columns:
        _df["month"] = pd.to_datetime(_df["date"], errors="coerce").dt.strftime("%Y-%m")
        unique_counts = _df.groupby("month", dropna=False)[product_name_col].nunique().reset_index()
        fig, ax = plt.subplots(figsize=(12, 4))
        ax.plot(
            unique_counts["month"], unique_counts[product_name_col], marker="o", color=GBD_colors[0]
        )
        ax.set_title("Number of Unique Products by Month")
        ax.set_xlabel("Month")
        ax.set_ylabel("Unique Count")
        ax.tick_params(axis="x", rotation=45)
        plt.tight_layout()
        figs.append(fig)

    for metric_column in _numeric_columns_for_profile(_df):
        figs.append(plot_metric_by_month(_df, metric_column))

    return figs


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


def plot_emissions_over_time(
    monthly_category_data: pd.DataFrame,
    emissions_col: str = "emissions_kg_co2e",
) -> Figure:
    """Total emissions trend line over time."""
    totals = monthly_totals(monthly_category_data, emissions_col)
    plot_data = pd.DataFrame({"month_year": totals.index, "value": totals.values})

    fig = plot_time_series_with_periods(
        data=plot_data,
        y_col="value",
        y_label="Total kg CO\u2082e",
        title="Total Carbon Emissions Over Time",
        use_period_hue=False,
    )

    def _millions_formatter(x, _):
        if abs(x) >= 1e6:
            return f"{x / 1e6:,.1f}M"
        if abs(x) >= 1e3:
            return f"{x / 1e3:,.0f}k"
        return f"{x:,.0f}"

    fig.axes[0].yaxis.set_major_formatter(mticker.FuncFormatter(_millions_formatter))
    return fig


def plot_emissions_per_diner_meal_over_time(
    monthly_category_data: pd.DataFrame,
    diner_meal_mapping: dict[Any, Any],
    emissions_col: str = "emissions_kg_co2e",
    diner_or_meal: str = "diner",
) -> Figure:
    """Per-diner emissions trend line."""
    totals = monthly_totals(monthly_category_data, emissions_col)
    per_dm, _, _ = divide_by_diner_meals(totals, diner_meal_mapping, strict=False)
    plot_data = pd.DataFrame({"month_year": per_dm.index, "value": per_dm.values})

    return plot_time_series_with_periods(
        data=plot_data,
        y_col="value",
        y_label=f"kg CO2e per {diner_or_meal.title()}",
        title=f"Carbon Emissions per {diner_or_meal.title()} Over Time",
        use_period_hue=False,
    )


def plot_emissions_summary_over_time(
    monthly_category_data: pd.DataFrame,
    diner_meal_mapping: dict[Any, Any],
    emissions_col: str = "emissions_kg_co2e",
    diner_or_meal: str = "diner",
    figsize: tuple[float, float] = (12, 4.8),
) -> Figure:
    """Put total and per-diner emissions trends together on one report page."""
    totals = monthly_totals(monthly_category_data, emissions_col)
    per_dm, _, _ = divide_by_diner_meals(totals, diner_meal_mapping, strict=False)

    total_plot_data = pd.DataFrame({"month_year": totals.index, "value": totals.values})
    per_diner_plot_data = pd.DataFrame({"month_year": per_dm.index, "value": per_dm.values})

    fig, axes = plt.subplots(1, 2, figsize=figsize)
    set_suptitle_font(fig, "Carbon Emissions Over Time", fontsize=16)

    _draw_metric_over_time_on_axis(
        axes[0],
        total_plot_data,
        title="Total Carbon Emissions Over Time",
        y_label="Total kg CO\u2082e",
    )

    def _millions_formatter(x, _):
        if abs(x) >= 1e6:
            return f"{x / 1e6:,.1f}M"
        if abs(x) >= 1e3:
            return f"{x / 1e3:,.0f}k"
        return f"{x:,.0f}"

    axes[0].yaxis.set_major_formatter(mticker.FuncFormatter(_millions_formatter))

    _draw_metric_over_time_on_axis(
        axes[1],
        per_diner_plot_data,
        title=f"Carbon Emissions per {diner_or_meal.title()} Over Time",
        y_label=f"kg CO2e per {diner_or_meal.title()}",
    )

    fig.tight_layout(rect=(0, 0, 1, 0.92))
    return fig


def _draw_share_bar_axis(
    ax: plt.Axes,
    share_pct: float,
    *,
    title: str,
    primary_label: str,
    secondary_label: str,
    primary_color: str,
    secondary_color: str,
    xlabel: str,
) -> None:
    """Draw a simple 100% stacked bar for a two-way share."""
    ax.barh(
        [title],
        [share_pct],
        color=primary_color,
        label=f"{primary_label} ({share_pct:.1f}%)",
    )
    ax.barh(
        [title],
        [100 - share_pct],
        left=[share_pct],
        color=secondary_color,
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
    line_color: str,
    empty_message: str,
) -> bool:
    """Draw a monthly share trend or show a friendly fallback message."""
    if (
        monthly is None
        or monthly.empty
        or "month_year" not in monthly.columns
        or value_column not in monthly.columns
    ):
        ax.axis("off")
        ax.text(0.5, 0.6, title, ha="center", va="center", fontsize=12, fontweight="bold")
        ax.text(0.5, 0.42, empty_message, ha="center", va="center", fontsize=10, color="gray")
        return False

    monthly_sorted = monthly.sort_values("month_year").copy()
    x_pos = range(len(monthly_sorted))
    ax.plot(x_pos, monthly_sorted[value_column].values, marker="o", color=line_color)
    ax.axhline(50, color="gray", linestyle="--", linewidth=0.8, alpha=0.6)
    ax.set_ylim(0, 100)
    ax.set_ylabel(y_label)
    ax.set_xticks(list(x_pos))
    ax.set_xticklabels(format_month_labels(monthly_sorted["month_year"]), rotation=45)
    add_grid(ax)
    set_title_font(ax, title)
    return True


def plot_plant_breakdown_overview(
    plant_animal_split: dict[str, Any] | None,
    plant_protein_share: dict[str, Any] | None,
    metric_label: str = "Kilos",
) -> Figure:
    """Combine the plant and protein share visuals into a single four-panel page."""
    plant_color = GBD_colors[2] if len(GBD_colors) > 2 else "#4CAF50"
    animal_color = GBD_colors[0] if GBD_colors else "#F44336"
    other_color = GBD_colors[0] if GBD_colors else "#F44336"

    fig, axes = plt.subplots(2, 2, figsize=(13, 7.6))
    set_suptitle_font(fig, "Plant and Protein Breakdown", fontsize=16)

    ax_bar = axes[0, 0]
    if plant_animal_split is not None:
        _draw_share_bar_axis(
            ax_bar,
            float(plant_animal_split["plant_pct"]),
            title="Plant vs. Animal Split",
            primary_label="Plant-based",
            secondary_label="Animal-based",
            primary_color=plant_color,
            secondary_color=animal_color,
            xlabel=f"% of total {metric_label.lower()} (plant + animal categories only)",
        )
    else:
        ax_bar.axis("off")
        ax_bar.text(
            0.5,
            0.6,
            "Plant vs. Animal Split",
            ha="center",
            va="center",
            fontsize=12,
            fontweight="bold",
        )
        ax_bar.text(
            0.5,
            0.42,
            "Plant/animal data was not available.",
            ha="center",
            va="center",
            fontsize=10,
            color="gray",
        )

    ax_trend = axes[0, 1]
    plant_animal_monthly = plant_animal_split.get("monthly") if plant_animal_split else None
    _draw_monthly_share_axis(
        ax_trend,
        plant_animal_monthly,
        value_column="plant_pct",
        title="Plant-Based % by Month",
        y_label="% plant-based",
        line_color=plant_color,
        empty_message="Monthly plant/animal data was not available.",
    )

    ax_protein_bar = axes[1, 0]
    if plant_protein_share is not None:
        _draw_share_bar_axis(
            ax_protein_bar,
            float(plant_protein_share["plant_protein_pct"]),
            title="Plant Protein Share",
            primary_label="Plant protein",
            secondary_label="Other protein",
            primary_color=plant_color,
            secondary_color=other_color,
            xlabel=f"% of total {metric_label.lower()} in protein categories",
        )
    else:
        ax_protein_bar.axis("off")
        ax_protein_bar.text(
            0.5,
            0.6,
            "Plant Protein Share",
            ha="center",
            va="center",
            fontsize=12,
            fontweight="bold",
        )
        ax_protein_bar.text(
            0.5,
            0.42,
            "Plant protein data was not available.",
            ha="center",
            va="center",
            fontsize=10,
            color="gray",
        )

    ax_protein_trend = axes[1, 1]
    plant_protein_monthly = plant_protein_share.get("monthly") if plant_protein_share else None
    _draw_monthly_share_axis(
        ax_protein_trend,
        plant_protein_monthly,
        value_column="plant_protein_pct",
        title="Plant Protein % by Month",
        y_label="% plant protein",
        line_color=plant_color,
        empty_message="Monthly plant protein data was not available.",
    )

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


def plot_plant_animal_split_single_period(
    plant_animal_split: dict[str, Any],
    metric_label: str = "Kilos",
) -> Figure:
    """Two-panel chart showing plant vs. animal breakdown.

    Left panel: stacked horizontal bar showing total % plant vs. % animal.
    Right panel: line chart of the monthly plant % trend.
    """
    plant_pct = plant_animal_split["plant_pct"]
    animal_pct = plant_animal_split["animal_pct"]
    monthly = plant_animal_split.get("monthly")

    has_monthly = (
        monthly is not None
        and not monthly.empty
        and "plant_pct" in monthly.columns
        and len(monthly) > 1
    )

    ncols = 2 if has_monthly else 1
    fig, axes = plt.subplots(1, ncols, figsize=(12 if has_monthly else 7, 3.5))
    if ncols == 1:
        axes = [axes]

    # Left panel: stacked bar
    ax_bar = axes[0]
    plant_color = GBD_colors[2] if len(GBD_colors) > 2 else "#4CAF50"
    animal_color = GBD_colors[0] if GBD_colors else "#F44336"
    ax_bar.barh(
        ["Food purchases"], [plant_pct], color=plant_color, label=f"Plant-based ({plant_pct:.1f}%)"
    )
    ax_bar.barh(
        ["Food purchases"],
        [animal_pct],
        left=[plant_pct],
        color=animal_color,
        label=f"Animal-based ({animal_pct:.1f}%)",
    )
    ax_bar.set_xlim(0, 100)
    ax_bar.set_xlabel(f"% of total {metric_label.lower()} (plant + animal categories only)")
    ax_bar.legend(loc="lower right", fontsize=9)
    set_title_font(ax_bar, "Plant vs. Animal Split")
    ax_bar.axvline(50, color="gray", linestyle="--", linewidth=0.8, alpha=0.6)
    add_grid(ax_bar, axis="x")

    # Right panel: monthly plant % trend
    if has_monthly:
        ax_trend = axes[1]
        x_pos = range(len(monthly))
        ax_trend.plot(x_pos, monthly["plant_pct"].values, marker="o", color=plant_color)
        ax_trend.axhline(50, color="gray", linestyle="--", linewidth=0.8, alpha=0.6)
        ax_trend.set_ylim(0, 100)
        ax_trend.set_ylabel("% plant-based")
        formatted_labels = format_month_labels(monthly["month_year"])
        ax_trend.set_xticks(list(x_pos))
        ax_trend.set_xticklabels(formatted_labels, rotation=45)
        add_grid(ax_trend)
        set_title_font(ax_trend, "Plant-Based % by Month")

    plt.tight_layout()
    return fig


def plot_plant_protein_share(
    plant_protein_share: dict[str, Any],
    metric_label: str = "Kilos",
) -> Figure:
    """Show overall and monthly plant-protein share within protein categories."""
    overall_pct = plant_protein_share["plant_protein_pct"]
    monthly = plant_protein_share.get("monthly")

    has_monthly = (
        monthly is not None
        and not monthly.empty
        and "plant_protein_pct" in monthly.columns
        and len(monthly) > 1
    )

    ncols = 2 if has_monthly else 1
    fig, axes = plt.subplots(1, ncols, figsize=(12 if has_monthly else 7, 3.5))
    if ncols == 1:
        axes = [axes]

    plant_color = GBD_colors[2] if len(GBD_colors) > 2 else "#4CAF50"
    other_color = GBD_colors[0] if GBD_colors else "#F44336"

    ax_bar = axes[0]
    ax_bar.barh(
        ["Protein categories"],
        [overall_pct],
        color=plant_color,
        label=f"Plant protein ({overall_pct:.1f}%)",
    )
    ax_bar.barh(
        ["Protein categories"],
        [100 - overall_pct],
        left=[overall_pct],
        color=other_color,
        label=f"Other protein ({100 - overall_pct:.1f}%)",
    )
    ax_bar.set_xlim(0, 100)
    ax_bar.set_xlabel(f"% of total {metric_label.lower()} in protein categories")
    ax_bar.legend(loc="lower right", fontsize=9)
    set_title_font(ax_bar, "Plant Protein Share")
    ax_bar.axvline(50, color="gray", linestyle="--", linewidth=0.8, alpha=0.6)
    add_grid(ax_bar, axis="x")

    if has_monthly:
        ax_trend = axes[1]
        x_pos = range(len(monthly))
        ax_trend.plot(
            x_pos,
            monthly["plant_protein_pct"].values,
            marker="o",
            color=plant_color,
        )
        ax_trend.axhline(50, color="gray", linestyle="--", linewidth=0.8, alpha=0.6)
        ax_trend.set_ylim(0, 100)
        ax_trend.set_ylabel("% plant protein")
        ax_trend.set_xticks(list(x_pos))
        ax_trend.set_xticklabels(format_month_labels(monthly["month_year"]), rotation=45)
        add_grid(ax_trend)
        set_title_font(ax_trend, "Plant Protein % by Month")

    plt.tight_layout()
    return fig


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

        cat_figs = plot_category_drivers(category_drivers, metric=metric_total)
        for cat_name, fig in cat_figs.items():
            fig = _remove_duplicate_xlabels(fig)
            caption = f"Top Products — {standardize_title_case(cat_name)}"
            if has_input_warning:
                caption += " [DATA WARNING]"
                fig.suptitle(caption, fontsize=10, color="#b22222", y=0.99)
            plots.append(("", fig))
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
