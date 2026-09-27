"""
Shared plotting utilities for GBD analysis.

This module provides common plotting functions, styles, and utilities used across
aggregate.py and results.py to reduce code duplication and ensure consistent styling.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Literal

import matplotlib
import pandas as pd

# Use non-interactive backend to prevent hanging on import
matplotlib.use("Agg")
import textwrap

import matplotlib.font_manager as font_manager
import matplotlib.pyplot as plt
import seaborn as sns
from matplotlib.patches import Rectangle

from gbd_foodservice_insights import PACKAGE_DIR

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

# Registered with matplotlib's font_manager below rather than relied on from the OS: the worker
# image ships neither font, so without this the report silently renders in DejaVu Sans.
FONT_FILES = [
    "Lato-Regular.ttf",
    "Lato-Bold.ttf",
    "Montserrat-Regular.ttf",
    "Montserrat-Bold.ttf",
]


@contextmanager
def close_new_figures_on_error() -> Iterator[None]:
    """On an exception, closes every pyplot figure opened inside the block, since none of them
    reached an owner who would close it. Wrap only our own code: a caller's figure opened inside
    the block would be closed too."""
    before = set(plt.get_fignums())
    try:
        yield
    except BaseException:
        for number in set(plt.get_fignums()) - before:
            plt.close(number)
        raise


def setup_gbd_fonts() -> None:
    """
    Configure matplotlib to use GBD fonts: Montserrat for titles, Lato for body text.

    Registers the packaged Regular/Bold font files so this holds regardless of what fonts the
    OS has installed; falls back to sans-serif only if that registration is somehow missing.
    """
    fonts_dir = PACKAGE_DIR / "data_files" / "fonts"
    for font_file in FONT_FILES:
        font_manager.fontManager.addfont(str(fonts_dir / font_file))

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
    """Set a title with Montserrat font; `kwargs` go to `set_title`."""
    ax.set_title(title, fontname=TITLE_FONT, fontsize=fontsize, **kwargs)


def set_suptitle_font(fig: plt.Figure, title: str, fontsize: int = 16, **kwargs) -> None:
    """Set a figure suptitle with Montserrat font; `kwargs` go to `suptitle`."""
    fig.suptitle(title, fontname=TITLE_FONT, fontsize=fontsize, **kwargs)


# Apply GBD styling on module import
sns.set_palette(GBD_colors)
setup_gbd_fonts()

# ----------------------------------------------------------------------
# Common Plotting Utilities
# ----------------------------------------------------------------------


def set_ylim_with_padding(ax: plt.Axes, data: pd.Series, padding: float = 0.2) -> None:
    """Set y-axis limits with padding above and below the data range. We do this to give the graph
    better perspective.

    The lower limit is scaled by `1 - padding` and the upper by `1 + padding`, so the padding is
    relative to each limit's value, not the range; this assumes positive data.
    """
    ymin, ymax = data.min(), data.max()
    ax.set_ylim(ymin * (1 - padding), ymax * (1 + padding))


def format_month_labels(month_values: Any) -> list[str]:
    """Converts month values in 'Jan-2025' format

    Handles an array-like of pandas Period objects, datetime objects, or strings in various
    formats.
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


def add_grid(
    ax: plt.Axes,
    axis: Literal["both", "x", "y"] = "both",
    linestyle: str = "--",
    alpha: float = 0.7,
) -> None:
    """Add a grid to the plot with consistent GBD styling."""
    ax.grid(True, axis=axis, linestyle=linestyle, alpha=alpha)


def wrap_labels(labels: list[str], max_width: int = 30) -> list[str]:
    """Wrap long labels to multiple lines of at most `max_width` characters."""
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
    """Convert a percentage column to float, handling both string and numeric types.

    If the column contains strings with '%' suffix (e.g., "25.5%"), removes the '%'
    and converts to float. If already numeric, creates a copy as float. The result goes in a
    new "{percentage_col}_float" column.
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
    """Calculate appropriate figure height for plots with wrapped labels.

    This function estimates the needed figure height based on the number of items
    and the maximum number of lines in wrapped labels. The returned height is in inches and is
    never below `base_height`.
    """
    wrapped = wrap_labels(labels, max_width)
    max_lines = max((label.count("\n") + 1) for label in wrapped) if wrapped else 1
    n_items = len(labels)
    return max(base_height, n_items * height_per_item * max_lines + 1)


def create_horizontal_percentage_barplot(
    ax: plt.Axes,
    data: pd.DataFrame,
    y_col: str,
    percentage_col: str = "percentage",
    max_label_width: int = 30,
    add_percentage_labels: bool = True,
    palette: list[str] | None = None,
) -> None:
    """Create a horizontal bar plot, with percentage values and optional text labels.

    This function creates a horizontal bar plot where the x-axis represents percentages
    (0-100) and optionally adds percentage text labels at the end of each bar.

    `data` must have been processed with convert_percentage_to_float() to have
    "{percentage_col}_float". `palette` defaults to GBD_colors.
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
