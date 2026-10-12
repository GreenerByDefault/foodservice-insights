"""
GBD's chart styling and the helpers shared by `report/plots` and the lab's plots.

Importing this module applies the house style: the Agg backend, the palette, and the Lato and
Montserrat fonts.
"""

from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from itertools import cycle, islice
from typing import Literal

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

GBD_COLORS = [
    "#234162",
    "#1b9f8d",
    "#d9e027",
    "#88a8d8",
    "#9f4870",
    "#a6979c",
    "#016939",
]

# Every report page is US Letter, so the PDF prints and scales as one document: text pages
# portrait, charts and tables landscape.
LETTER_PORTRAIT = (8.5, 11.0)
LETTER_LANDSCAPE = (11.0, 8.5)

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
sns.set_palette(GBD_COLORS)
setup_gbd_fonts()

# ----------------------------------------------------------------------
# Common Plotting Utilities
# ----------------------------------------------------------------------


def format_month_labels(months: Iterable[pd.Period]) -> list[str]:
    """Labels like 'Jan-2025'."""
    return [month.strftime("%b-%Y") for month in months]


def add_grid(
    ax: plt.Axes,
    axis: Literal["both", "x", "y"] = "both",
    linestyle: str = "--",
    alpha: float = 0.7,
) -> None:
    """Add a grid to the plot with consistent GBD styling."""
    ax.grid(True, axis=axis, linestyle=linestyle, alpha=alpha)


def wrap_labels(labels: list[str], max_width: int = 30, max_lines: int = 3) -> list[str]:
    """Wrap long labels to lines of at most `max_width` characters, ending in an ellipsis past
    `max_lines`."""
    return [
        textwrap.fill(str(label), width=max_width, max_lines=max_lines, placeholder=" …")
        for label in labels
    ]


# ----------------------------------------------------------------------
# Specialized Plotting Helpers
# ----------------------------------------------------------------------


def standardize_title_case(text: str) -> str:
    """
    Convert text to title case and addresses annoying edge case where it capitalizes 's as in
    Farmer'S oat milk
    """
    return text.title().replace("'S", "'s")


def create_horizontal_percentage_barplot(
    ax: plt.Axes,
    data: pd.DataFrame,
    y_col: str,
    percentage_col: str = "percentage",
    max_label_width: int = 30,
    add_percentage_labels: bool = True,
) -> None:
    """Create a horizontal bar plot, with percentage values and optional text labels.

    This function creates a horizontal bar plot where the x-axis represents percentages
    (0-100) and optionally adds percentage text labels at the end of each bar.
    """
    sns.barplot(
        data=data,
        y=y_col,
        x=percentage_col,
        hue=y_col,
        # Exactly one color per bar: seaborn warns when the list is longer or shorter.
        palette=list(islice(cycle(GBD_COLORS), data[y_col].nunique())),
        legend=False,
        ax=ax,
    )
    # Bars are keyed on the full label and only the tick text is shortened: two labels that
    # truncate alike would otherwise be averaged into one bar.
    ax.set_yticks(ax.get_yticks(), labels=wrap_labels(data[y_col].tolist(), max_label_width))

    ax.set_xlim(0, 100)

    if add_percentage_labels:
        bar_rectangles = [patch for patch in ax.patches if isinstance(patch, Rectangle)]
        for i, patch in enumerate(bar_rectangles):
            pct = data.iloc[i][percentage_col]
            x = patch.get_width()
            y = patch.get_y() + patch.get_height() / 2
            ax.text(x + 1, y, f"{pct:.1f}%", va="center", fontsize=10, color="black")

    ax.tick_params(axis="y", labelsize=10)
