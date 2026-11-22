"""What every PDF page is drawn on: blank page figures, and text measured and wrapped to fit."""

from collections.abc import Sequence
from typing import Protocol

import matplotlib.pyplot as plt
from matplotlib.figure import Figure
from matplotlib.font_manager import FontProperties
from matplotlib.textpath import text_to_path

from gbd_foodservice_insights.plotting_utils import LETTER_PORTRAIT

PAGE_MARGIN_IN = 1.0
# A fraction of the page height.
LINE_HEIGHT = 0.025


class PdfSink(Protocol):
    """All the page writers need of ``PdfPages``, so a test can record pages instead."""

    def savefig(self, figure: Figure, /) -> None: ...


def new_text_figure(fig_size: tuple[float, float] = LETTER_PORTRAIT) -> tuple[Figure, plt.Axes]:
    """Create a blank figure, with its single axes turned off, for rendering text or tables."""
    fig, ax = plt.subplots(figsize=fig_size)
    ax.axis("off")
    return fig, ax


def new_page_figure(fig_size: tuple[float, float]) -> tuple[Figure, plt.Axes]:
    """A blank figure whose axes coordinates are page coordinates. The default subplot margins
    are lopsided, pushing left-aligned text off center."""
    fig, ax = new_text_figure(fig_size)
    ax.set_position((0, 0, 1, 1))
    return fig, ax


def text_width_in(text: str, prop: FontProperties) -> float:
    width_pt, _, _ = text_to_path.get_text_width_height_descent(text, prop, ismath=False)
    return width_pt / 72


def wrap_to_width(
    text: str,
    max_width_in: float,
    fontsize: float,
    fontfamily: str | Sequence[str],
    fontweight: str = "normal",
) -> list[str]:
    """Greedily wrap ``text`` so each line's rendered width fits within ``max_width_in``."""
    prop = FontProperties(family=fontfamily, size=fontsize, weight=fontweight)
    lines: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}" if current else word
        if current and text_width_in(candidate, prop) > max_width_in:
            lines.append(current)
            current = word
        else:
            current = candidate
    return [*lines, current] if current else lines
