"""
Shared plotting utilities for GBD analysis.

This module provides common plotting functions, styles, and utilities used across
aggregate.py and results.py to reduce code duplication and ensure consistent styling.
"""

from typing import Any, Literal

import matplotlib
import pandas as pd

# Use non-interactive backend to prevent hanging on import
matplotlib.use("Agg")
import textwrap

import matplotlib.pyplot as plt
import seaborn as sns
from matplotlib.patches import Rectangle

# ----------------------------------------------------------------------
# Color Palette & Style Constants
# ----------------------------------------------------------------------

GBD_colors = [
    "#234162",
    "#1b9f8d",
    "#d9e027",
    "#88a8d8",
    "#9f4870",
    "#a6979c",
    "#016939",
]

# ----------------------------------------------------------------------
# Font Configuration
# ----------------------------------------------------------------------

# GBD font settings: Montserrat for titles, Lato for body text
TITLE_FONT = "Montserrat"
BODY_FONT = "Lato"


def setup_gbd_fonts() -> None:
    """
    Configure matplotlib to use GBD fonts: Montserrat for titles, Lato for body text.

    Falls back to sans-serif if fonts are not installed.
    """
    plt.rcParams.update(
        {
            # Default font family (Lato for body text)
            "font.family": "sans-serif",
            "font.sans-serif": [BODY_FONT, "DejaVu Sans", "Arial", "sans-serif"],
            # Font sizes
            "axes.titlesize": 14,
            "axes.labelsize": 12,
            "xtick.labelsize": 10,
            "ytick.labelsize": 10,
            "legend.fontsize": 10,
            "figure.titlesize": 16,
        }
    )


def set_title_font(ax: plt.Axes, title: str, fontsize: int = 14, **kwargs) -> None:
    """
    Set a title with Montserrat font.

    Args:
        ax (plt.Axes): The axes object to set title on.
        title (str): The title text.
        fontsize (int, optional): Font size. Defaults to 14.
        **kwargs: Additional keyword arguments passed to set_title.
    """
    ax.set_title(title, fontname=TITLE_FONT, fontsize=fontsize, **kwargs)


def set_suptitle_font(fig: plt.Figure, title: str, fontsize: int = 16, **kwargs) -> None:
    """
    Set a figure suptitle with Montserrat font.

    Args:
        fig (plt.Figure): The figure object to set suptitle on.
        title (str): The title text.
        fontsize (int, optional): Font size. Defaults to 16.
        **kwargs: Additional keyword arguments passed to suptitle.
    """
    fig.suptitle(title, fontname=TITLE_FONT, fontsize=fontsize, **kwargs)


# Apply GBD styling on module import
sns.set_palette(GBD_colors)
setup_gbd_fonts()

# ----------------------------------------------------------------------
# Common Plotting Utilities
# ----------------------------------------------------------------------


def set_ylim_with_padding(ax: plt.Axes, data: pd.Series, padding: float = 0.2) -> None:
    """
    Set y-axis limits with padding above and below the data range. We do this to give the graph
    better perspective.

    Args:
        ax (plt.Axes): The axes object to modify.
        data (pd.Series): The data series to calculate limits from.
        padding (float, optional): Fraction of range to add as padding. Defaults to 0.2.
    """
    ymin, ymax = data.min(), data.max()
    ax.set_ylim(ymin * (1 - padding), ymax * (1 + padding))


def format_month_labels(month_values: Any) -> list[str]:
    """
    Converts month values in 'Jan-2025' format

    Handles pandas Period objects, datetime objects, or strings in various formats.

    Args:
        month_values: Array-like of month identifiers (Period, datetime, or string format)

    Returns:
        List[str]: Formatted month labels in 'Mon-YYYY' format (e.g., 'Jan-2025')
    """
    formatted_labels = []
    for month in month_values:
        try:
            # Handle pandas Period objects
            if hasattr(month, "strftime"):
                formatted_labels.append(month.strftime("%b-%Y"))
            # Handle string formats like '2024-01' or '2024-01-01'
            elif isinstance(month, str):
                dt = pd.to_datetime(month)
                formatted_labels.append(dt.strftime("%b-%Y"))
            else:
                # Fallback: convert to string as-is
                formatted_labels.append(str(month))
        except ValueError, AttributeError:
            # If all parsing fails, use string representation
            formatted_labels.append(str(month))

    return formatted_labels


def rotate_x_labels(ax: plt.Axes, rotation: int = 45) -> None:
    """Rotate the x-axis tick labels on an axes by the given angle.

    Args:
        ax (plt.Axes): The axes whose x-tick labels should be rotated.
        rotation (int, optional): Rotation angle in degrees. Defaults to 45.
    """
    # Does not need a docstring
    ax.tick_params(axis="x", rotation=rotation)


def add_grid(
    ax: plt.Axes,
    axis: Literal["both", "x", "y"] = "both",
    linestyle: str = "--",
    alpha: float = 0.7,
) -> None:
    """
    Add a grid to the plot with consistent GBD styling.

    Args:
        ax (plt.Axes): The axes object to modify.
        axis (str, optional): Which axis to add grid to ('x', 'y', or 'both'). Defaults to 'both'.
        linestyle (str, optional): Line style for grid. Defaults to '--'.
        alpha (float, optional): Transparency of grid lines. Defaults to 0.7.
    """
    ax.grid(True, axis=axis, linestyle=linestyle, alpha=alpha)


def wrap_labels(labels: list[str], max_width: int = 30) -> list[str]:
    """
    Wrap long labels to multiple lines.

    Args:
        labels (List[str]): List of labels to wrap.
        max_width (int, optional): Maximum characters per line. Defaults to 30.

    Returns:
        List[str]: List of wrapped labels.
    """
    return [textwrap.fill(str(label), width=max_width) for label in labels]


def format_percentage_column(df: pd.DataFrame, column: str = "percentage") -> pd.DataFrame:
    """
    Format a percentage column by adding '%' suffix.
    """
    df = df.copy()
    df[column] = df[column].round(1).astype(str) + "%"
    return df


# ----------------------------------------------------------------------
# Specialized Plotting Helpers
# ----------------------------------------------------------------------


def standardize_title_case(text: str) -> str:
    """
    Convert text to title case and addresses annoying edge case where it capitalizes 's as in
    Farmer'S oat milk
    """
    return text.title().replace("'S", "'s")


def convert_percentage_to_float(
    df: pd.DataFrame, percentage_col: str = "percentage"
) -> pd.DataFrame:
    """
    Convert a percentage column to float, handling both string and numeric types.

    If the column contains strings with '%' suffix (e.g., "25.5%"), removes the '%'
    and converts to float. If already numeric, creates a copy as float.

    Args:
        df (pd.DataFrame): DataFrame containing the percentage column.
        percentage_col (str, optional): Name of the percentage column. Defaults to "percentage".

    Returns:
        pd.DataFrame: DataFrame with an additional "{percentage_col}_float" column.
    """
    df = df.copy()
    if pd.api.types.is_string_dtype(df[percentage_col]):
        df[f"{percentage_col}_float"] = df[percentage_col].str.rstrip("%").astype(float)
    else:
        df[f"{percentage_col}_float"] = df[percentage_col].astype(float)
    return df


def calculate_figure_height_for_wrapped_labels(
    labels: list[str], max_width: int = 30, base_height: float = 4.0, height_per_item: float = 0.35
) -> float:
    """
    Calculate appropriate figure height for plots with wrapped labels.

    This function estimates the needed figure height based on the number of items
    and the maximum number of lines in wrapped labels.

    Args:
        labels (List[str]): List of labels that will be wrapped.
        max_width (int, optional): Maximum characters per line for wrapping. Defaults to 30.
        base_height (float, optional): Minimum figure height. Defaults to 4.0.
        height_per_item (float, optional): Height to add per item. Defaults to 0.35.

    Returns:
        float: Calculated figure height in inches.
    """
    wrapped = wrap_labels(labels, max_width)
    max_lines = max((label.count("\n") + 1) for label in wrapped) if wrapped else 1
    n_items = len(labels)
    return max(base_height, n_items * height_per_item * max_lines + 1)


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
    """
    Create a standardized time series line plot, optionally comparing baseline vs pilot periods.

    This is a reusable helper for creating consistent time series plots across the codebase.
    It handles all common formatting: period colors, legend styling, month label formatting,
    gridlines, and axis configuration.

    Supports two modes:
    - Baseline + Pilot comparison (use_period_hue=True): Different colored lines for each period
    - Single time series (use_period_hue=False): One line, no period grouping

    Args:
        data (pd.DataFrame): DataFrame with time series data. Must contain x_col and y_col.
                            If use_period_hue=True, must also contain period_col.
        y_col (str): Column name for y-axis values.
        y_label (str): Label for y-axis.
        title (str): Plot title.
        figsize (Tuple[int, int], optional): Figure size. Defaults to (12, 4).
        x_col (str, optional): Column name for x-axis (time). Defaults to "month_year".
        period_col (Optional[str], optional): Column name for period grouping. Defaults to "period".
                                             Ignored if use_period_hue=False.
        ylim_padding_factor (Optional[float], optional): Y-axis padding as fraction of max value.
                                                         If None, no ylim is set. Defaults to 0.1.
        marker (str, optional): Marker style. Defaults to "o".
        markersize (int, optional): Marker size. Defaults to 8.
        linewidth (int, optional): Line width. Defaults to 2.
        x_label (str, optional): Label for x-axis. Defaults to "" (empty string).
        use_period_hue (bool, optional): Whether to use period column for different colored lines.
                                        Defaults to True.

    Returns:
        plt.Figure: The matplotlib Figure object.

    Examples:
        >>> # Baseline + Pilot comparison
        >>> fig = plot_time_series_with_periods(
        ...     data=monthly_data,
        ...     y_col="kilos_per_diner_meal",
        ...     y_label="Kilos per Diner-Meal",
        ...     title="Food Consumption Over Time"
        ... )
        >>>
        >>> # Single time series (baseline only)
        >>> fig = plot_time_series_with_periods(
        ...     data=baseline_data,
        ...     y_col="diner-meals",
        ...     y_label="Number of Diner-Meals",
        ...     title="Diner-Meal Numbers Over Time",
        ...     use_period_hue=False
        ... )
    """
    data_sorted = data.sort_values(x_col).copy()

    # Convert Period objects to strings for plotting compatibility
    if pd.api.types.is_period_dtype(data_sorted[x_col]):
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


def create_horizontal_percentage_barplot(
    ax: plt.Axes,
    data: pd.DataFrame,
    y_col: str,
    percentage_col: str = "percentage",
    max_label_width: int = 30,
    add_percentage_labels: bool = True,
    palette: list[str] | None = None,
) -> None:
    """
    Create a horizontal bar plot, with percentage values and optional text labels.

    This function creates a horizontal bar plot where the x-axis represents percentages
    (0-100) and optionally adds percentage text labels at the end of each bar.

    Args:
        ax (plt.Axes): The axes object to plot on.
        data (pd.DataFrame): DataFrame containing the data. Must have been processed
                            with convert_percentage_to_float() to have "{percentage_col}_float".
        y_col (str): Column name for y-axis labels.
        percentage_col (str, optional): Base name of percentage column. Defaults to "percentage".
        max_label_width (int, optional): Maximum width for wrapping y-axis labels. Defaults to 30.
        add_percentage_labels (bool, optional): Whether to add percentage text at bar ends.
            Defaults to True.
        palette (Optional[List[str]], optional): Color palette for bars. Defaults to GBD_colors.
    """
    if palette is None:
        palette = GBD_colors

    wrapped_col = f"wrapped_{y_col}"
    data[wrapped_col] = wrap_labels(data[y_col].tolist(), max_label_width)

    sns.barplot(
        data=data,
        y=wrapped_col,
        x=f"{percentage_col}_float",
        hue=wrapped_col,
        palette=palette,
        legend=False,
        ax=ax,
    )

    ax.set_xlim(0, 100)

    if add_percentage_labels:
        bar_rectangles = [patch for patch in ax.patches if isinstance(patch, Rectangle)]
        for i, patch in enumerate(bar_rectangles):
            pct = data.iloc[i][f"{percentage_col}_float"]
            x = patch.get_width()
            y = patch.get_y() + patch.get_height() / 2
            ax.text(x + 1, y, f"{pct:.1f}%", va="center", fontsize=10, color="black")

    ax.tick_params(axis="y", labelsize=10)
