"""PDF report assembly for food reports."""

import logging
import re
import textwrap
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import NamedTuple

import matplotlib.pyplot as plt
import pandas as pd
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.figure import Figure
from matplotlib.font_manager import FontProperties
from matplotlib.table import Cell
from matplotlib.textpath import text_to_path
from matplotlib.transforms import Bbox

from gbd_foodservice_insights.plotting_utils import (
    LETTER_LANDSCAPE,
    LETTER_PORTRAIT,
    close_new_figures_on_error,
)
from gbd_foodservice_insights.report.aggregation import AnimalEmissionsConcentration
from gbd_foodservice_insights.report.food_report import FoodReport, ReportCharts, date_range_label
from gbd_foodservice_insights.report.metric import KILOS
from gbd_foodservice_insights.report.quality import Finding
from gbd_foodservice_insights.report.schema import (
    DiagnosticStatus,
    DinerOrMeal,
    QualityStatus,
    quality_status_from_findings,
    summarize_status_counts,
)

logger = logging.getLogger(__name__)

_TEXT_PAGE_TOP_Y = 0.88
_TEXT_PAGE_BOTTOM_Y = 0.06
_TEXT_PAGE_LINE_HEIGHT = 0.03
_TEXT_PAGE_WRAP_CHARS = 92

_SUMMARY_MARGIN_IN = 1.0
_SUMMARY_LINE_HEIGHT = 0.025

_TITLE_CLIENT_LINE_HEIGHT = 0.04

_TABLE_BBOX = Bbox.from_bounds(0.03, 0.06, 0.94, 0.84)


# ---------------------------------------------------------------------------
# PDF helpers
# ---------------------------------------------------------------------------


def _new_text_figure(fig_size: tuple[float, float] = LETTER_PORTRAIT) -> tuple[Figure, plt.Axes]:
    """Create a blank figure, with its single axes turned off, for rendering text or tables."""
    fig, ax = plt.subplots(figsize=fig_size)
    ax.axis("off")
    return fig, ax


def create_title_page(
    pdf: PdfPages,
    client: str,
    subtitle: str,
    fig_size: tuple[float, float] = LETTER_PORTRAIT,
) -> None:
    """Render a branded title page in the PDF."""
    fig, ax = _new_text_figure(fig_size)
    ax.text(
        0.5,
        0.65,
        "Food Report",
        transform=ax.transAxes,
        ha="center",
        va="center",
        fontsize=28,
        fontweight="bold",
        fontfamily="Montserrat",
    )
    # The client name is shown as typed: title-casing turns "McDonald's" into "Mcdonald'S".
    client_lines = _wrap_to_width(
        client.replace("_", " "),
        fig_size[0] - 2 * _SUMMARY_MARGIN_IN,
        fontsize=20,
        fontfamily="Montserrat",
    )
    y = 0.55
    for line in client_lines:
        ax.text(
            0.5,
            y,
            line,
            transform=ax.transAxes,
            ha="center",
            va="center",
            fontsize=20,
            fontfamily="Montserrat",
        )
        y -= _TITLE_CLIENT_LINE_HEIGHT
    subtitle_y = min(0.47, y - 0.02)
    ax.text(
        0.5,
        subtitle_y,
        subtitle,
        transform=ax.transAxes,
        ha="center",
        va="center",
        fontsize=14,
        fontfamily="Lato",
        color="gray",
    )
    ax.text(
        0.5,
        subtitle_y - 0.09,
        f"Generated {datetime.now().strftime('%d %B %Y')}",
        transform=ax.transAxes,
        ha="center",
        va="center",
        fontsize=11,
        fontfamily="Lato",
        color="gray",
    )
    ax.text(
        0.5,
        0.15,
        "Greener By Default",
        transform=ax.transAxes,
        ha="center",
        va="center",
        fontsize=12,
        fontfamily="Montserrat",
        color="#234162",
    )
    pdf.savefig(fig)
    plt.close(fig)


def _format_co2e(kg: float) -> str:
    """Human-scale CO₂e: tonnes from 2,000 kg, with one decimal below 10 tonnes."""
    if kg < 2000:
        return f"{kg:,.0f} kg"
    tonnes = kg / 1000
    if round(tonnes, 1) < 10:
        return f"{tonnes:.1f} tonnes"
    return f"{tonnes:,.0f} tonnes"


class CategoryShare(NamedTuple):
    category: str
    pct_of_footprint: float


@dataclass(frozen=True)
class ExecutiveNarrative:
    """The facts behind the plain-English executive summary."""

    client: str
    period: str
    total_food_kg: float
    total_co2e_kg: float
    co2e_kg_per_diner_or_meal: float
    diner_or_meal: DinerOrMeal
    # Percentages of the categorised food by weight.
    plant_pct: float
    animal_pct: float
    # Whether any animal product was bought, which `animal_pct` rounds away below 0.05%.
    any_animal: bool
    # The largest emitters, largest first.
    top_categories: tuple[CategoryShare, ...]
    quality_status: QualityStatus

    def __post_init__(self) -> None:
        if not 1 <= len(self.top_categories) <= 3:
            raise ValueError(f"Expected 1 to 3 top categories, got {len(self.top_categories)}")


def new_summary_figure(fig_size: tuple[float, float]) -> tuple[Figure, plt.Axes]:
    """A page headed "Executive Summary", whose axes coordinates are page coordinates."""
    fig, ax = _new_text_figure(fig_size)
    # The default subplot margins are lopsided, pushing left-aligned text off the right edge.
    ax.set_position((0, 0, 1, 1))
    ax.text(
        0.5,
        0.82,
        "Executive Summary",
        transform=ax.transAxes,
        ha="center",
        va="top",
        fontsize=20,
        fontweight="bold",
        fontfamily="Montserrat",
    )
    return fig, ax


def create_executive_summary_page(
    pdf: PdfPages,
    narrative: ExecutiveNarrative,
    fig_size: tuple[float, float] = LETTER_PORTRAIT,
) -> None:
    """Render the executive summary for readers who will never hear the report explained: a
    headline figure followed by short prose paragraphs."""
    fig, ax = new_summary_figure(fig_size)
    text_width_in = fig_size[0] - 2 * _SUMMARY_MARGIN_IN
    left_x = _SUMMARY_MARGIN_IN / fig_size[0]

    headline = _format_co2e(narrative.total_co2e_kg)
    ax.text(
        0.5,
        0.76,
        f"{headline} CO₂e",
        transform=ax.transAxes,
        ha="center",
        va="top",
        fontsize=34,
        fontweight="bold",
        fontfamily="Montserrat",
        color="#006a62",
    )
    subtitle = f"the climate footprint of food purchased by {narrative.client}, {narrative.period}"
    y = 0.70
    for line in _wrap_to_width(subtitle, text_width_in, fontsize=12, fontfamily="Lato"):
        ax.text(
            0.5,
            y,
            line,
            transform=ax.transAxes,
            ha="center",
            va="top",
            fontsize=12,
            fontfamily="Lato",
            color="#444444",
        )
        y -= _SUMMARY_LINE_HEIGHT

    y -= 0.035  # gap below the subtitle
    for paragraph in _narrative_paragraphs(narrative):
        for line in _wrap_to_width(paragraph, text_width_in, fontsize=11.5, fontfamily="Lato"):
            ax.text(
                left_x,
                y,
                line,
                transform=ax.transAxes,
                ha="left",
                va="top",
                fontsize=11.5,
                fontfamily="Lato",
            )
            y -= _SUMMARY_LINE_HEIGHT
        y -= 0.017  # paragraph gap

    pdf.savefig(fig)
    plt.close(fig)


def _share_text(pct: float, *, nonzero: bool) -> str:
    """`pct` as a whole percent, except that a nonzero share never reads as 0% or 100%."""
    if nonzero and pct < 0.5:
        return "under 1%"
    if nonzero and pct >= 99.5:
        return "over 99%"
    return f"{pct:.0f}%"


def _narrative_paragraphs(narrative: ExecutiveNarrative) -> list[str]:
    headline = _format_co2e(narrative.total_co2e_kg)
    paragraphs = []

    sentence = (
        f"Over this period the kitchen purchased about {narrative.total_food_kg:,.0f} kg "
        f"of categorised food. Producing that food released an estimated {headline} of carbon "
        "dioxide equivalent (CO₂e), the standard measure for comparing the climate impact of "
        "different foods. That works out at roughly "
        f"{narrative.co2e_kg_per_diner_or_meal:.2f} kg of CO₂e per {narrative.diner_or_meal}."
    )
    paragraphs.append(sentence)

    top = narrative.top_categories
    if len(top) == 3:
        first, second, third = top
        top_text = (
            f"{first.category} ({first.pct_of_footprint:.0f}% of the food footprint), "
            f"{second.category} ({second.pct_of_footprint:.0f}%) and {third.category} "
            f"({third.pct_of_footprint:.0f}%)"
        )
    else:
        top_text = " and ".join(f"{c.category} ({c.pct_of_footprint:.0f}%)" for c in top)
    paragraphs.append(f"The biggest contributors were {top_text}.")

    paragraphs.append(
        "All of the categorised food was plant-based."
        if not narrative.any_animal
        else (
            "Plant-based items made up "
            f"{_share_text(narrative.plant_pct, nonzero=narrative.plant_pct > 0)} of the "
            "categorised food by weight, and animal products "
            f"{_share_text(narrative.animal_pct, nonzero=True)}. Animal products carry far "
            "higher emissions per kilogram, so a small number of categories drive most of the "
            "footprint. Modest, targeted menu changes in those areas deliver the largest "
            "reductions."
        )
    )

    if narrative.quality_status != "pass":
        paragraphs.append(
            "Some data-quality notes apply to this analysis; they are listed in plain "
            "language at the back of this report."
        )
    paragraphs.append(
        "The pages that follow show how the footprint breaks down by month, category and "
        "product. The methodology is explained at the back."
    )
    return paragraphs


def create_text_page(
    pdf: PdfPages,
    title: str,
    content_lines: list[str],
    fig_size: tuple[float, float] = LETTER_PORTRAIT,
    bold_lines: set[str] | None = None,
) -> None:
    """Render a text page in the PDF, paginating long content as needed.

    Continuation pages get a ``" (cont.)"`` title suffix. Blank lines render as blank rows;
    lines in ``bold_lines`` (compared after stripping) render in bold.
    """
    wrapped_lines = _wrap_text_lines(content_lines)
    bold_lines = {line.strip() for line in (bold_lines or set())}
    lines_per_page = max(
        1,
        int((_TEXT_PAGE_TOP_Y - _TEXT_PAGE_BOTTOM_Y) / _TEXT_PAGE_LINE_HEIGHT) + 1,
    )

    for page_index in range(0, len(wrapped_lines), lines_per_page):
        fig, ax = _new_text_figure(fig_size)
        page_title = title if page_index == 0 else f"{title} (cont.)"

        ax.text(
            0.5,
            0.95,
            page_title,
            transform=ax.transAxes,
            ha="center",
            va="top",
            fontsize=16,
            fontweight="bold",
            fontfamily="Montserrat",
        )

        y = _TEXT_PAGE_TOP_Y
        for line in wrapped_lines[page_index : page_index + lines_per_page]:
            is_bold_line = line.strip() in bold_lines
            ax.text(
                0.08,
                y,
                line,
                transform=ax.transAxes,
                ha="left",
                va="top",
                fontsize=10,
                fontfamily="Lato",
                fontweight="bold" if is_bold_line else "normal",
            )
            y -= _TEXT_PAGE_LINE_HEIGHT

        pdf.savefig(fig)
        plt.close(fig)


def create_category_template_pages(
    pdf: PdfPages,
    template: pd.DataFrame,
    fig_size: tuple[float, float] = LETTER_LANDSCAPE,
) -> None:
    """Render the category x month template, splitting its months across as many pages as
    they need to render unclipped."""
    display_df = _display_table(_format_category_template_for_pdf(template))
    # One font size on every page, since the columns are measured at it. Each page repeats the
    # category column at its measured width, and its month columns share the rest of the page.
    font_size = 9.5
    row_scale = 1.18 if len(display_df.columns) <= 6 else 1.08
    widths = _table_column_widths_in(display_df, font_size)
    month_width = _table_width_in(fig_size) - widths[0]
    pages = _pack_columns(widths[1:], month_width)
    for page_number, page_columns in enumerate(pages, start=1):
        heading = (
            "Category Template"
            if len(pages) == 1
            else f"Category Template ({page_number} of {len(pages)})"
        )
        columns = [index + 1 for index in page_columns]
        slack = (month_width - sum(widths[index] for index in columns)) / max(len(columns), 1)
        _draw_table_page(
            pdf,
            heading,
            display_df.iloc[:, [0, *columns]],
            col_widths=[widths[0], *(widths[index] + slack for index in columns)],
            font_size=font_size,
            row_scale=row_scale,
            fig_size=fig_size,
        )


def create_animal_intensity_page(pdf: PdfPages, intensity: pd.DataFrame) -> None:
    _draw_table_page(
        pdf,
        "Animal Emissions Intensity",
        _display_table(_format_animal_emissions_intensity_for_pdf(intensity)),
        col_widths=None,
        font_size=7.5,
        row_scale=1.18,
    )


def create_substitution_scenarios_page(pdf: PdfPages, scenarios: pd.DataFrame) -> None:
    display_df = _display_table(_format_substitution_scenarios_for_pdf(scenarios))
    display_df["Scenario"] = display_df["Scenario"].map(
        lambda value: textwrap.fill(value, width=24, break_long_words=False, break_on_hyphens=False)
    )
    _draw_table_page(
        pdf,
        "Substitution Scenarios",
        display_df,
        col_widths=[0.30, 0.17, 0.16, 0.16, 0.21],
        font_size=10.0,
        row_scale=1.30,
        multiline_column="Scenario",
    )


def _display_table(table: pd.DataFrame) -> pd.DataFrame:
    """``table`` as the text a PDF table shows, with a named index as its first column."""
    if table.index.name is not None:
        table = table.reset_index()
    return table.map(_format_table_cell)


def _format_table_cell(value: object) -> object:
    if pd.isna(value):
        return ""
    if isinstance(value, int | float) and not isinstance(value, bool):
        if float(value).is_integer():
            return f"{int(value):,}"
        return f"{value:,.2f}".rstrip("0").rstrip(".")
    return value


def _table_width_in(fig_size: tuple[float, float]) -> float:
    """The width of `_TABLE_BBOX` on a `_new_text_figure` page, whose axes `plt.subplots`
    places by the figure.subplot rcParams."""
    axes_width = plt.rcParams["figure.subplot.right"] - plt.rcParams["figure.subplot.left"]
    return fig_size[0] * axes_width * _TABLE_BBOX.width


def _table_column_widths_in(display_df: pd.DataFrame, font_size: float) -> list[float]:
    """The width each column needs for its bold header and widest cell to render unclipped."""
    header = FontProperties(size=font_size, weight="bold")
    body = FontProperties(size=font_size)
    # A left-aligned cell starts its text `Cell.PAD` of its width in; pad the right to match.
    return [
        max(
            _text_width_in(str(column), header),
            *(_text_width_in(str(value), body) for value in display_df.iloc[:, index]),
        )
        / (1 - 2 * Cell.PAD)
        for index, column in enumerate(display_df.columns)
    ]


def _pack_columns(widths: list[float], available_width: float) -> list[list[int]]:
    """Greedily group column indexes, in order, into pages whose widths fit
    ``available_width``. A column too wide for any page gets a page of its own."""
    pages: list[list[int]] = [[]]
    used = 0.0
    for index, width in enumerate(widths):
        if pages[-1] and used + width > available_width:
            pages.append([])
            used = 0.0
        pages[-1].append(index)
        used += width
    return pages


def _draw_table_page(
    pdf: PdfPages,
    heading: str,
    display_df: pd.DataFrame,
    *,
    col_widths: list[float] | None,
    font_size: float,
    row_scale: float,
    fig_size: tuple[float, float] = LETTER_LANDSCAPE,
    multiline_column: str | None = None,
) -> None:
    """Draw ``display_df`` on one page under ``heading``. Each row grows to fit the lines of
    its ``multiline_column`` cell, which is drawn larger."""
    fig, ax = _new_text_figure(fig_size)

    ax.text(
        0.5,
        0.97,
        heading,
        transform=ax.transAxes,
        ha="center",
        va="top",
        fontsize=14,
        fontweight="bold",
        fontfamily="Montserrat",
    )

    table = ax.table(
        cellText=display_df.values.tolist(),
        colLabels=[str(column) for column in display_df.columns],
        bbox=_TABLE_BBOX,
        cellLoc="left",
        colWidths=col_widths,
    )
    table.auto_set_font_size(False)
    table.set_fontsize(font_size)
    table.scale(1.0, row_scale)

    for (_, _), cell in table.get_celld().items():
        cell.get_text().set_wrap(True)
        cell.set_edgecolor("#D9E1EA")
        cell.set_linewidth(0.6)

    if multiline_column is not None:
        multiline_col_idx = display_df.columns.get_loc(multiline_column)
        line_counts = [value.count("\n") + 1 for value in display_df[multiline_column]]
        for row_idx, line_count in enumerate(line_counts, start=1):
            row_height = table[row_idx, 0].get_height() * max(1.15, 1 + 0.9 * (line_count - 1))
            for col_idx in range(len(display_df.columns)):
                table[row_idx, col_idx].set_height(row_height)
                table[row_idx, col_idx].set_text_props(va="top")
            table[row_idx, multiline_col_idx].set_text_props(fontsize=11.25, va="top")

    # Style header
    for col_idx in range(len(display_df.columns)):
        cell = table[0, col_idx]
        cell.set_facecolor("#234162")
        cell.set_text_props(color="white", fontweight="bold")
        cell.set_edgecolor("#234162")
        cell.set_linewidth(0.8)

    for row_idx in range(1, len(display_df) + 1):
        for col_idx in range(len(display_df.columns)):
            cell = table[row_idx, col_idx]
            if row_idx % 2 == 0:
                cell.set_facecolor("#F5F8FB")
            else:
                cell.set_facecolor("white")

    pdf.savefig(fig)
    plt.close(fig)


def create_decision_kpis_page(
    pdf: PdfPages,
    concentration: AnimalEmissionsConcentration,
    fig_size: tuple[float, float] = LETTER_PORTRAIT,
) -> None:
    """Render the animal emissions concentration as a narrative text page."""
    fig, ax = _new_text_figure(fig_size)

    ax.text(
        0.5,
        0.95,
        "Decision KPIs",
        transform=ax.transAxes,
        ha="center",
        va="top",
        fontsize=16,
        fontweight="bold",
        fontfamily="Montserrat",
    )

    products = concentration.top_products
    share_text = f"{concentration.share_pct:.1f}".removesuffix(".0")
    intro_lines = _wrap_text_lines(
        [
            (
                f"The top {len(products)} animal products share of animal-product emissions was "
                f"{share_text}% amounting to {round(concentration.top_products_kg_co2e):,} kg "
                "CO₂e."
            ),
            "",
            f"The top {len(products)} animal "
            f"{'product was' if len(products) == 1 else 'products were'}:",
        ],
        width=80,
    )

    y = 0.84
    for line in intro_lines:
        ax.text(
            0.08,
            y,
            line,
            transform=ax.transAxes,
            ha="left",
            va="top",
            fontsize=11,
            fontfamily="Lato",
        )
        y -= 0.04

    for idx, product in enumerate(products, start=1):
        wrapped_product_lines = _wrap_text_lines([f"{idx}. {product}"], width=78)
        for line in wrapped_product_lines:
            ax.text(
                0.1,
                y,
                line,
                transform=ax.transAxes,
                ha="left",
                va="top",
                fontsize=10.5,
                fontfamily="Lato",
            )
            y -= 0.034
        y -= 0.01

    pdf.savefig(fig)
    plt.close(fig)


# ---------------------------------------------------------------------------
# Status label maps
# ---------------------------------------------------------------------------

_QUALITY_STATUS_SENTENCES: dict[QualityStatus, str] = {
    "pass": "All automated data checks passed — your data looks complete and consistent.",
    "warning": (
        "Your data passed most checks, but a few things are worth noting. See the details below."
    ),
    "invalid": (
        "One or more data issues were found that may affect the accuracy of these results. "
        "Please review the notes below before sharing this report."
    ),
}

_STATUS_LABELS: dict[DiagnosticStatus, str] = {
    "success": "\u2022 Passed",
    "info": "\u2022 Note",
    "warning": "\u2022 Warning",
    "error": "\u2022 Issue",
}


def quality_lines(findings: Sequence[Finding], *, show_successes: bool) -> list[str]:
    """Turn the quality findings into plain lines for the PDF report. Without
    ``show_successes`` (the customer's report), only warnings and issues are listed, and notes
    are not counted."""
    counts = summarize_status_counts(findings)
    count_parts = [
        f"{count} {noun if count == 1 else plural}"
        for count, noun, plural in (
            (counts["success"], "passed", "passed"),
            (counts["info"] if show_successes else 0, "note", "notes"),
            (counts["warning"], "warning", "warnings"),
            (counts["error"], "issue", "issues"),
        )
        if count
    ]
    lines = [
        (
            "This section summarises the automated checks run on your data before this report "
            "was produced."
        ),
        "",
        _QUALITY_STATUS_SENTENCES[quality_status_from_findings(findings)],
    ]
    if count_parts:
        lines.append("  " + "  ·  ".join(count_parts))

    visible = [f for f in findings if show_successes or f["status"] in {"warning", "error"}]
    if not visible:
        return [*lines, "", "No issues were detected."]

    lines += ["", "Check details:"]
    for finding in visible[:20]:
        lines.append(f"  {_STATUS_LABELS[finding['status']]}:  {finding['message']}")
        lines += [f"      - {value}" for value in finding.get("sample_values", [])[:5]]
    return lines


def _text_width_in(text: str, prop: FontProperties) -> float:
    width_pt, _, _ = text_to_path.get_text_width_height_descent(text, prop, ismath=False)
    return width_pt / 72


def _wrap_to_width(text: str, max_width_in: float, fontsize: float, fontfamily: str) -> list[str]:
    """Greedily wrap ``text`` so each line's rendered width fits within ``max_width_in``."""
    prop = FontProperties(family=fontfamily, size=fontsize)
    lines: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}" if current else word
        if current and _text_width_in(candidate, prop) > max_width_in:
            lines.append(current)
            current = word
        else:
            current = candidate
    return [*lines, current] if current else lines


def _wrap_text_lines(content_lines: list[str], width: int = _TEXT_PAGE_WRAP_CHARS) -> list[str]:
    """Wrap text-page lines before rendering so spacing matches visible rows.

    Preserves leading indentation and bullet prefixes.
    """
    wrapped_lines: list[str] = []

    for line in content_lines:
        if not line.strip():
            wrapped_lines.append("")
            continue

        leading_spaces = len(line) - len(line.lstrip(" "))
        stripped = line.lstrip(" ")
        initial_indent = " " * leading_spaces
        subsequent_indent = initial_indent

        bullet_match = re.match(r"([•-])\s+", stripped)
        if bullet_match:
            bullet_prefix = bullet_match.group(0)
            text = stripped[bullet_match.end() :]
            initial_indent = (" " * leading_spaces) + bullet_prefix
            subsequent_indent = " " * len(initial_indent)
        else:
            text = stripped

        wrapper = textwrap.TextWrapper(
            width=width,
            initial_indent=initial_indent,
            subsequent_indent=subsequent_indent,
            break_long_words=False,
            break_on_hyphens=False,
        )
        wrapped_lines.extend(wrapper.wrap(text) or [line])

    return wrapped_lines or [""]


def _how_to_read_lines(diner_or_meal: DinerOrMeal) -> list[str]:
    """Introductory guide to reading the report, shown before the charts."""
    return [
        "The charts in this report show your catering operation's food purchasing patterns",
        "and associated carbon footprint over the reporting period.",
        "",
        "Key things to look for:",
        "  \u2022 Which food categories contribute most to your total carbon footprint.",
        "  \u2022 Which specific products are the biggest drivers within those categories.",
        "  \u2022 How purchasing volumes vary month to month.",
        "",
        f"The 'per {diner_or_meal}' figures are the most useful for comparing across months,",
        f"because they account for how many {diner_or_meal}s were served each month.",
        "",
        "The plant vs. animal breakdown shows the proportion of food purchased from",
        "plant-based vs. animal-based sources. Shifting this ratio is one of the most",
        "effective ways to reduce your carbon footprint.",
        "",
        "The top driver products are the ones you bought the most of by weight, which makes",
        "them a good place to start when planning menu changes. They are not ranked by carbon:",
        "a heavy, low-carbon item can outrank a lighter, high-carbon one.",
    ]


def _methodology_lines(diner_or_meal: DinerOrMeal) -> list[str]:
    """Methodology note for the final page of the PDF."""
    return [
        (
            "This report was produced by Greener By Default using procurement data provided by "
            "your organisation."
        ),
        "",
        "What is procurement data?",
        "  Procurement data records the food and ingredients your catering operation purchases.",
        "  It captures what was ordered, not necessarily what was served or consumed by diners.",
        "",
        "How are carbon figures calculated?",
        "  Each food item is assigned to a high-level category (e.g. Poultry, Legumes, Dairy).",
        (
            "  A carbon emissions factor — measured in kg of CO\u2082e per kg of food — "
            "is then applied."
        ),
        "  These factors are drawn from peer-reviewed life-cycle assessment research.",
        "  Total carbon is the sum of (weight \u00d7 emissions factor) across all items.",
        "  This means two foods with the same weight can have very different carbon footprints",
        "  depending on how they are produced.",
        "",
        "How should I interpret the monthly figures?",
        "  Month-to-month variation is normal and expected. Purchasing volumes fluctuate with",
        "  seasonal menus, catering events, term dates, and other operational factors.",
        (
            f"  Per-{diner_or_meal} figures account for this by normalising against the number "
            f"of {diner_or_meal}s served."
        ),
        "",
        "How should I use this report?",
        "  The highest-carbon categories and products are the most impactful places to focus",
        "  menu changes. Even modest reductions in high-carbon items can produce significant",
        "  carbon savings at scale. Greener By Default can help you identify practical",
        "  substitutions that maintain menu quality and diner satisfaction.",
        "",
        "Figures in this report are relative to your own data. No external benchmark is applied.",
    ]


# ---------------------------------------------------------------------------
# Report tables
# ---------------------------------------------------------------------------


def _format_animal_emissions_intensity_for_pdf(intensity: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "Category": intensity["category"],
            "Kilos of Food": intensity["kilos_total"].round().astype("Int64"),
            "CO₂e Per Kg Food": intensity["kg_co2e_per_kg_food"].round(2),
            "Kg CO₂e": intensity["total_kg_co2e"].round().astype("Int64"),
        }
    )


def _format_category_template_for_pdf(template: pd.DataFrame) -> pd.DataFrame:
    def _format_label(value: object) -> object:
        if not isinstance(value, str):
            return value
        return value.replace("_", " ").title()

    display_df = template.copy()
    display_df.columns = [_format_label(column) for column in display_df.columns]
    if display_df.index.name is not None:
        display_df.index = display_df.index.rename(_format_label(display_df.index.name))
    return display_df


def _format_substitution_scenarios_for_pdf(scenarios: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "Scenario": scenarios["scenario"],
            "Weight Replaced (kg)": scenarios["replaced_weight_kg"].round().astype("Int64"),
            "Projected Kg CO₂e": scenarios["projected_emissions_kg_co2e"].round().astype("Int64"),
            "Avoidable Kg CO₂e": scenarios["avoidable_kg_co2e"].round().astype("Int64"),
            "Institution Emissions Averted (%)": scenarios[
                "institution_emissions_avoided_pct"
            ].round(2),
        }
    )


# ---------------------------------------------------------------------------
# PDF builder
# ---------------------------------------------------------------------------


def write_report_pdf(
    report: FoodReport,
    charts: ReportCharts,
    path: Path,
    *,
    client_name: str,
    show_quality_successes: bool,
) -> None:
    """Write the report's PDF. With ``show_quality_successes`` (the data scientist's report),
    the quality section lists passed checks and notes too; without it (the customer's), only
    warnings and issues."""
    quality_status = quality_status_from_findings(report.findings)
    aggregation = report.aggregation

    with close_new_figures_on_error(), PdfPages(path) as pdf:
        create_title_page(pdf, client_name, "Procurement")
        create_executive_summary_page(
            pdf, _executive_narrative(report, client_name, quality_status)
        )
        create_text_page(pdf, "How to Read This Report", _how_to_read_lines(report.diner_or_meal))

        for fig in charts.figures:
            pdf.savefig(fig)

        create_category_template_pages(pdf, aggregation.template)
        if aggregation.animal_emissions_intensity is not None:
            create_animal_intensity_page(pdf, aggregation.animal_emissions_intensity)
        if aggregation.animal_emissions_concentration is not None:
            create_decision_kpis_page(pdf, aggregation.animal_emissions_concentration)
        if aggregation.substitution_scenarios is not None:
            create_substitution_scenarios_page(pdf, aggregation.substitution_scenarios)

        methodology = _methodology_lines(report.diner_or_meal)
        create_text_page(
            pdf,
            "About This Report",
            methodology,
            bold_lines={line for line in methodology if line.endswith("?")},
        )
        create_text_page(
            pdf,
            "Data Completeness & Quality",
            quality_lines(report.findings, show_successes=show_quality_successes),
        )

    logger.info("PDF report saved to %s", path)


def _executive_narrative(
    report: FoodReport, client_name: str, quality_status: QualityStatus
) -> ExecutiveNarrative:
    # Positive: every GBD category has a nonzero emission factor, and `build_food_report` rejects
    # rows that all weigh 0.
    co2e_by_cat = report.emissions_summary.dropna(subset=["total_kg_co2e"])
    total_co2e = float(co2e_by_cat["total_kg_co2e"].sum())

    # A category bought only at zero weight sums to 0 and would otherwise fill a spare slot.
    top = co2e_by_cat[co2e_by_cat["total_kg_co2e"] > 0].nlargest(3, "total_kg_co2e")
    return ExecutiveNarrative(
        client=client_name,
        period=date_range_label(report.rows),
        total_food_kg=float(report.rows[KILOS.column].sum()),
        total_co2e_kg=total_co2e,
        # Positive, since `build_food_report` requires a positive count for every month.
        co2e_kg_per_diner_or_meal=total_co2e / report.diner_meals_in_data,
        diner_or_meal=report.diner_or_meal,
        plant_pct=report.plant_animal_split.plant_pct,
        animal_pct=report.plant_animal_split.animal_pct,
        any_animal=report.plant_animal_split.animal_total > 0,
        top_categories=tuple(
            CategoryShare(str(category), 100 * kg_co2e / total_co2e)
            for category, kg_co2e in zip(top["category"], top["total_kg_co2e"], strict=True)
        ),
        quality_status=quality_status,
    )
