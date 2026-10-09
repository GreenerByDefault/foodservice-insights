from collections.abc import Callable
from typing import Any

import matplotlib.colors as mcolors
import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns
from gbd_foodservice_insights.categories import clean_GBD_category_name
from gbd_foodservice_insights.plotting_utils import (
    GBD_colors,
    add_grid,
    format_month_labels,
    set_title_font,
)

GBD_cmap = mcolors.ListedColormap(GBD_colors)

# Period color mapping for baseline vs pilot comparisons
PERIOD_COLORS = {
    "baseline": GBD_colors[0],
    "pilot": GBD_colors[1],
}


def setup_seaborn_palette() -> None:
    """Set up seaborn with GBD color palette."""
    sns.set_palette(GBD_colors)


def update_legend_to_title_case(ax: plt.Axes) -> None:
    """Convert all legend label texts on the axes to title case in place."""
    legend = ax.legend() if hasattr(ax, "legend") else None
    if legend is not None:
        for text in legend.get_texts():
            text.set_text(text.get_text().title())


def calculate_subplot_grid(n_items: int, n_cols: int = 4) -> tuple[int, int]:
    """Calculate the (n_rows, n_cols) needed for a subplot grid."""
    n_rows = (n_items + n_cols - 1) // n_cols
    return n_rows, n_cols


def hide_unused_subplots(axes: list[plt.Axes], n_used: int) -> None:
    """Hide unused subplots in a grid."""
    for idx in range(n_used, len(axes)):
        axes[idx].set_visible(False)


def clean_category_label(label: str) -> str:
    """Clean a category label with clean_GBD_category_name, or return it as-is if that fails."""
    try:
        cleaned = clean_GBD_category_name(label)
        return cleaned if cleaned is not None else label
    except KeyError, ValueError, AttributeError:
        return label


def create_line_plot_with_periods(
    ax: plt.Axes,
    data: pd.DataFrame,
    x_col: str,
    y_col: str,
    period_col: str = "period",
    color_map: dict | None = None,
    marker: str = "o",
    linewidth: int = 2,
    markersize: int = 6,
) -> None:
    """Create a line plot with separate lines for each period (baseline/pilot).

    `color_map` defaults to PERIOD_COLORS.
    """
    if color_map is None:
        color_map = PERIOD_COLORS

    periods = sorted(data[period_col].unique())

    for period in periods:
        period_data = data[data[period_col] == period].sort_values(x_col)
        ax.plot(
            period_data[x_col],
            period_data[y_col],
            marker=marker,
            label=period.title(),
            color=color_map.get(period, "gray"),
            linewidth=linewidth,
            markersize=markersize,
        )


def create_category_subplot_grid(
    categories: list[str],
    monthly_data: pd.DataFrame,
    plot_func: Callable[..., None],
    n_cols: int = 4,
    figsize_per_plot: tuple[int, int] = (5, 3),
    **plot_kwargs: Any,
) -> plt.Figure:
    """Create a grid of subplots, one for each category, using a custom plot function.

    `plot_func` is called as `plot_func(ax, category_data, category_name, **plot_kwargs)`.
    """
    n_categories = len(categories)
    n_rows, n_cols = calculate_subplot_grid(n_categories, n_cols)

    fig, axes = plt.subplots(
        n_rows, n_cols, figsize=(figsize_per_plot[0] * n_cols, figsize_per_plot[1] * n_rows)
    )

    # Handle different subplot return types
    if n_rows == 1 and n_cols == 1:
        axes = [axes]
    elif n_rows == 1 or n_cols == 1:
        # Already a 1D array, no need to flatten
        axes = axes
    else:
        # 2D array, need to flatten
        axes = axes.flatten()

    for idx, category in enumerate(categories):
        ax = axes[idx]
        category_data = monthly_data[monthly_data["category"] == category]
        plot_func(ax, category_data, category, **plot_kwargs)

    hide_unused_subplots(axes, n_categories)

    return fig


def plot_time_series_with_periods(
    data: pd.DataFrame,
    y_col: str,
    y_label: str,
    title: str,
    figsize: tuple[int, int] = (12, 4),
    x_col: str = "month_year",
    period_col: str | None = "period",
    ylim_padding_factor: float | None = 0.1,
    marker: str = "o",
    markersize: int = 8,
    linewidth: int = 2,
    x_label: str = "",
    use_period_hue: bool = True,
) -> plt.Figure:
    """Create a standardized time series line plot, optionally comparing baseline vs pilot.

    With `use_period_hue`, each period gets its own colored line; otherwise one line is drawn and
    `period_col` is ignored. `data` must contain `x_col` and `y_col`, plus `period_col` when
    `use_period_hue` is True. `ylim_padding_factor` pads the y-axis as a fraction of the max
    value; None leaves ylim unset.
    """
    data_sorted = data.sort_values(x_col).copy()

    # Convert Period objects to strings for plotting compatibility
    if isinstance(data_sorted[x_col].dtype, pd.PeriodDtype):
        data_sorted[x_col] = data_sorted[x_col].astype(str)

    fig, ax = plt.subplots(figsize=figsize)

    # Create line plot with or without period hue
    if use_period_hue and period_col and period_col in data_sorted.columns:
        sns.lineplot(
            data=data_sorted,
            x=x_col,
            y=y_col,
            hue=period_col,
            marker=marker,
            markersize=markersize,
            linewidth=linewidth,
            ax=ax,
        )
    else:
        # Single time series without period grouping
        sns.lineplot(
            data=data_sorted,
            x=x_col,
            y=y_col,
            marker=marker,
            markersize=markersize,
            linewidth=linewidth,
            color=GBD_colors[0] if isinstance(GBD_colors, list) and GBD_colors else None,
            ax=ax,
        )

    ax.set_xlabel(x_label, fontsize=12)
    ax.set_ylabel(y_label, fontsize=12)
    set_title_font(ax, title, fontsize=14)

    unique_months = sorted(data_sorted[x_col].unique())
    formatted_labels = format_month_labels(unique_months)
    ax.set_xticks(unique_months)
    ax.set_xticklabels(formatted_labels, rotation=45)

    if ylim_padding_factor is not None:
        y_max = data_sorted[y_col].max()
        ax.set_ylim(0, y_max * (1 + ylim_padding_factor))

    # Apply consistent styling
    if use_period_hue and period_col and period_col in data_sorted.columns:
        legend = ax.legend() if hasattr(ax, "legend") else None
        if legend is not None:
            for text in legend.get_texts():
                text.set_text(text.get_text().title())
    add_grid(ax)

    plt.tight_layout()
    return fig
