"""The title page, and pages of wrapped, paginated text."""

import re
from datetime import datetime

import matplotlib.pyplot as plt
from matplotlib.font_manager import FontProperties

from gbd_foodservice_insights.plotting_utils import (
    BODY_FONT,
    GBD_CHARTREUSE,
    GBD_GREEN,
    GBD_MUTED,
    LETTER_PORTRAIT,
    TITLE_FONT,
)
from gbd_foodservice_insights.report.aggregation import AnimalEmissionsConcentration
from gbd_foodservice_insights.report.pdf.layout import (
    LINE_HEIGHT,
    PAGE_MARGIN_IN,
    PdfSink,
    draw_heading,
    draw_wrapped,
    new_page_figure,
    new_text_figure,
    text_width_in,
    wrap_to_width,
)

# Text pages' coordinates are fractions of the page.
_TEXT_PAGE_TITLE_Y = 0.92
_TEXT_PAGE_TOP_Y = 0.86
_TEXT_PAGE_BOTTOM_Y = 0.08
_TEXT_PAGE_FONT_SIZE = 11

_TITLE_LINE_HEIGHT = 0.05
_TITLE_CLIENT_LINE_HEIGHT = 0.04


def create_title_page(
    pdf: PdfSink,
    title: str,
    client: str,
    subtitle: str,
    fig_size: tuple[float, float] = LETTER_PORTRAIT,
) -> None:
    """Render a branded title page in the PDF."""
    fig, ax = new_text_figure(fig_size)
    title_lines = wrap_to_width(
        title,
        fig_size[0] - 2 * PAGE_MARGIN_IN,
        fontsize=28,
        fontfamily=TITLE_FONT,
        fontweight="bold",
    )
    # A long title grows up the page, so its last line keeps its place above the client.
    for index, line in enumerate(title_lines):
        y = 0.65 + (len(title_lines) - 1 - index) * _TITLE_LINE_HEIGHT
        draw_heading(ax, y, line, fontsize=28, va="center")
    # Decoration only: chartreuse is too faint on white to carry text.
    ax.plot(
        [0.44, 0.56],
        [0.605, 0.605],
        transform=ax.transAxes,
        color=GBD_CHARTREUSE,
        linewidth=5,
        solid_capstyle="round",
    )
    # The client name is shown as typed: title-casing turns "McDonald's" into "Mcdonald'S".
    y = draw_wrapped(
        ax,
        0.5,
        0.55,
        client.replace("_", " "),
        width_in=fig_size[0] - 2 * PAGE_MARGIN_IN,
        line_height=_TITLE_CLIENT_LINE_HEIGHT,
        fontsize=20,
        fontfamily=TITLE_FONT,
        ha="center",
        va="center",
    )
    subtitle_y = min(0.47, y - 0.02)
    ax.text(
        0.5,
        subtitle_y,
        subtitle,
        transform=ax.transAxes,
        ha="center",
        va="center",
        fontsize=14,
        fontfamily=BODY_FONT,
        color=GBD_MUTED,
    )
    ax.text(
        0.5,
        0.15,
        "Greener By Default",
        transform=ax.transAxes,
        ha="center",
        va="center",
        fontsize=12,
        fontfamily=TITLE_FONT,
        color=GBD_GREEN,
    )
    ax.text(
        0.5,
        0.02,
        f"Generated {datetime.now().strftime('%d %B %Y')}",
        transform=ax.transAxes,
        ha="center",
        va="center",
        fontsize=9,
        fontfamily=BODY_FONT,
        color=GBD_MUTED,
    )
    pdf.savefig(fig)
    plt.close(fig)


def create_text_page(
    pdf: PdfSink,
    title: str,
    content_lines: list[str],
    fig_size: tuple[float, float] = LETTER_PORTRAIT,
    bold_lines: set[str] | None = None,
) -> None:
    """Render a text page in the PDF, paginating long content as needed.

    Continuation pages get a ``" (cont.)"`` title suffix. Blank lines render as blank rows;
    lines in ``bold_lines`` (compared after stripping) render in bold.
    """
    wrapped_lines = _wrap_text_lines(
        content_lines, fig_size[0] - 2 * PAGE_MARGIN_IN, _TEXT_PAGE_FONT_SIZE
    )
    bold_lines = {line.strip() for line in (bold_lines or set())}
    lines_per_page = int((_TEXT_PAGE_TOP_Y - _TEXT_PAGE_BOTTOM_Y) / LINE_HEIGHT) + 1

    for page_index in range(0, len(wrapped_lines), lines_per_page):
        fig, ax = new_page_figure(fig_size)
        page_title = title if page_index == 0 else f"{title} (cont.)"
        draw_heading(ax, _TEXT_PAGE_TITLE_Y, page_title, fontsize=16)

        y = _TEXT_PAGE_TOP_Y
        for line in wrapped_lines[page_index : page_index + lines_per_page]:
            is_bold_line = line.strip() in bold_lines
            ax.text(
                PAGE_MARGIN_IN / fig_size[0],
                y,
                line,
                transform=ax.transAxes,
                ha="left",
                va="top",
                fontsize=_TEXT_PAGE_FONT_SIZE,
                fontfamily=BODY_FONT,
                fontweight="bold" if is_bold_line else "normal",
            )
            y -= LINE_HEIGHT

        pdf.savefig(fig)
        plt.close(fig)


def _wrap_text_lines(content_lines: list[str], max_width_in: float, fontsize: float) -> list[str]:
    """Wrap text-page lines to ``max_width_in`` before rendering, so spacing matches visible
    rows. Keeps leading indentation, and hangs wrapped text under a bullet or list number."""
    prop = FontProperties(family=BODY_FONT, size=fontsize)
    wrapped_lines: list[str] = []
    for line in content_lines:
        if not line.strip():
            wrapped_lines.append("")
            continue
        stripped = line.lstrip(" ")
        marker = re.match(r"(?:[•-]|\d+\.)\s+", stripped)
        first_prefix = line[: len(line) - len(stripped)] + (marker.group(0) if marker else "")
        hanging_prefix = " " * len(first_prefix)
        # Spaces are narrower than a bullet, so the wider prefix bounds every line.
        text_width = max_width_in - max(
            text_width_in(first_prefix, prop), text_width_in(hanging_prefix, prop)
        )
        text = stripped[marker.end() :] if marker else stripped
        body = wrap_to_width(text, text_width, fontsize=fontsize, fontfamily=BODY_FONT)
        wrapped_lines += [first_prefix + body[0], *(hanging_prefix + rest for rest in body[1:])]
    return wrapped_lines or [""]


def create_decision_kpis_page(
    pdf: PdfSink,
    concentration: AnimalEmissionsConcentration,
    fig_size: tuple[float, float] = LETTER_PORTRAIT,
) -> None:
    """Render the animal emissions concentration as a narrative text page."""
    products = concentration.top_products
    share_text = f"{concentration.share_pct:.1f}".removesuffix(".0")
    subject = (
        "The animal product with the highest emissions"
        if len(products) == 1
        else f"The {len(products)} animal products with the highest emissions"
    )
    intro = (
        f"{subject} accounted for {share_text}% of animal-product emissions "
        f"({round(concentration.top_products_kg_co2e):,} kg CO₂e):"
    )
    numbered = [f"  {index}. {product}" for index, product in enumerate(products, start=1)]
    create_text_page(pdf, "Decision KPIs", [intro, "", *numbered], fig_size)
