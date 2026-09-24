from collections.abc import Callable
from typing import Any

import matplotlib.colors as mcolors
import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns
from gbd_foodservice_insights.categories import clean_GBD_category_name
from gbd_foodservice_insights.plotting_utils import GBD_colors

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
    """Convert all legend label texts on the axes to title case in place.

    Args:
        ax (plt.Axes): The axes object containing the legend to update.
    """
    legend = ax.legend() if hasattr(ax, "legend") else None
    if legend is not None:
        for text in legend.get_texts():
            text.set_text(text.get_text().title())


def calculate_subplot_grid(n_items: int, n_cols: int = 4) -> tuple[int, int]:
    """
    Calculate the number of rows and columns needed for a subplot grid.

    Args:
        n_items (int): Number of items to display in the grid.
        n_cols (int, optional): Number of columns. Defaults to 4.

    Returns:
        Tuple[int, int]: (n_rows, n_cols) for the subplot grid.
    """
    n_rows = (n_items + n_cols - 1) // n_cols
    return n_rows, n_cols


def hide_unused_subplots(axes: list[plt.Axes], n_used: int) -> None:
    """
    Hide unused subplots in a grid.

    Args:
        axes (List[plt.Axes]): List of axes objects from subplots.
        n_used (int): Number of subplots actually being used.
    """
    for idx in range(n_used, len(axes)):
        axes[idx].set_visible(False)


def clean_category_label(label: str) -> str:
    """
    Clean a category label, attempting to use clean_GBD_category_name with fallback.

    Args:
        label (str): The category label to clean.

    Returns:
        str: Cleaned label, or original if cleaning fails.
    """
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
    """
    Create a line plot with separate lines for each period (baseline/pilot).

    Args:
        ax (plt.Axes): The axes object to plot on.
        data (pd.DataFrame): Data to plot.
        x_col (str): Column name for x-axis.
        y_col (str): Column name for y-axis.
        period_col (str, optional): Column name for period. Defaults to "period".
        color_map (Optional[dict], optional): Color mapping for periods. Defaults to PERIOD_COLORS.
        marker (str, optional): Marker style. Defaults to "o".
        linewidth (int, optional): Line width. Defaults to 2.
        markersize (int, optional): Marker size. Defaults to 6.
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
    """
    Create a grid of subplots, one for each category, using a custom plot function.

    Args:
        categories (List[str]): List of category names.
        monthly_data (pd.DataFrame): Data containing all categories.
        plot_func: Function that takes (ax, category_data, category_name, **kwargs).
        n_cols (int, optional): Number of columns. Defaults to 4.
        figsize_per_plot (Tuple[int, int], optional): Size per subplot. Defaults to (5, 3).
        **plot_kwargs: Additional keyword arguments passed to plot_func.

    Returns:
        plt.Figure: The created figure.
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
