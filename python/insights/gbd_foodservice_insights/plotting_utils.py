"""
GBD's chart styling and the helpers shared by `report/plots` and the lab's plots.

Importing this module applies the house style: the Agg backend, the palette, the Poppins font
and brown ink. The colors are GBD's 2026 rebrand, as `apps/web/src/routes/layout.css` ships them.
"""

from collections.abc import Generator, Iterable
from contextlib import contextmanager
from typing import Literal

import matplotlib
import pandas as pd

# Use non-interactive backend to prevent hanging on import
matplotlib.use("Agg")
import textwrap

import matplotlib.font_manager as font_manager
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import seaborn as sns
from matplotlib.axis import Axis
from matplotlib.patches import Rectangle

from gbd_foodservice_insights import PACKAGE_DIR

# ----------------------------------------------------------------------
# Color Palette & Style Constants
# ----------------------------------------------------------------------

GBD_GREEN = "#016939"
GBD_CHARTREUSE = "#D9E027"
GBD_BROWN = "#403428"
GBD_MUTED = "#6E6052"
GBD_SAND = "#F4EEE2"
GBD_CREAM = "#FDF9F1"
GBD_BORDER = "#E6DDCC"

# Leads with GBD green; the rest are chosen to stay apart from their neighbors on a white page,
# under protanopia and deuteranopia too. Chartreuse is left out: at 1.4:1 on white, a line or a
# thin bar in it all but disappears.
GBD_COLORS = [
    GBD_GREEN,
    "#3A64C0",
    "#D0661E",
    "#B23B78",
    "#788C00",
    "#8E4520",
    "#1A9C8C",
]

# Every report page is US Letter, so the PDF prints and scales as one document: text pages
# portrait, charts and tables landscape.
LETTER_PORTRAIT = (8.5, 11.0)
LETTER_LANDSCAPE = (11.0, 8.5)

# The strip at the foot of every page, as a fraction of its height, that holds the page number.
# Charts lay out above it.
PAGE_FOOTER_HEIGHT = 0.04

# ----------------------------------------------------------------------
# Font Configuration
# ----------------------------------------------------------------------

# Poppins has no subscript digits, so the ₂ of every "CO₂e" falls back to Lato, whose ₂ sits below
# the baseline as a subscript should. A family named alone gets no fallback, hence the pairs.
TITLE_FONT = ("Poppins", "Lato")
BODY_FONT = ("Poppins", "Lato")

# Registered with matplotlib's font_manager below rather than relied on from the OS: the worker
# image ships neither font, so without this the report silently renders in DejaVu Sans.
FONT_FILES = [
    "Poppins-Regular.ttf",
    "Poppins-Bold.ttf",
    "Lato-Regular.ttf",
    "Lato-Bold.ttf",
]


@contextmanager
def close_new_figures_on_error() -> Generator[None]:
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
    """Register the packaged fonts, so the house style holds whatever the OS has installed, and
    make them and GBD's ink the defaults."""
    fonts_dir = PACKAGE_DIR / "data_files" / "fonts"
    for font_file in FONT_FILES:
        font_manager.fontManager.addfont(str(fonts_dir / font_file))

    plt.rcParams.update(
        {
            # Named rather than "sans-serif", which resolves to a single font and so no fallback.
            "font.family": list(BODY_FONT),
            "text.color": GBD_BROWN,
            "axes.labelcolor": GBD_BROWN,
            "axes.titlecolor": GBD_BROWN,
            "axes.edgecolor": GBD_MUTED,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "xtick.color": GBD_MUTED,
            "ytick.color": GBD_MUTED,
            "xtick.labelcolor": GBD_BROWN,
            "ytick.labelcolor": GBD_BROWN,
            "grid.color": GBD_BORDER,
            "legend.labelcolor": GBD_BROWN,
            "axes.titlesize": 14,
            "axes.labelsize": 12,
            "xtick.labelsize": 10,
            "ytick.labelsize": 10,
            "legend.fontsize": 10,
            "figure.titlesize": 16,
        }
    )


def set_title_font(
    ax: plt.Axes, title: str, fontsize: int = 14, fontweight: str = "bold", **kwargs
) -> None:
    """Set a chart title in the title font; `kwargs` go to `set_title`."""
    ax.set_title(title, fontfamily=TITLE_FONT, fontsize=fontsize, fontweight=fontweight, **kwargs)


def set_page_title_font(ax: plt.Axes, title: str) -> None:
    """Title a single-chart page to match `set_suptitle_font`'s titles of multi-chart pages."""
    set_title_font(ax, title, fontsize=16, color=GBD_GREEN, pad=12)


def set_suptitle_font(fig: plt.Figure, title: str, fontsize: int = 16, **kwargs) -> None:
    """Set a page title in the title font and GBD green; `kwargs` go to `suptitle`."""
    fig.suptitle(
        title,
        fontfamily=TITLE_FONT,
        fontsize=fontsize,
        fontweight="bold",
        color=GBD_GREEN,
        **kwargs,
    )


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


def group_thousands(axis: Axis) -> None:
    """Label ticks like 25,000, keeping any fraction: per-head values can be below 1."""
    axis.set_major_formatter(mticker.FuncFormatter(lambda value, _: f"{value:,.10g}"))


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
        # One color: the bars are one series, and their lengths already rank them.
        color=GBD_GREEN,
        # Seaborn otherwise dulls the color it is given.
        saturation=1,
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
            ax.text(x + 1, y, f"{pct:.1f}%", va="center", fontsize=10)

    ax.tick_params(axis="y", labelsize=10)
