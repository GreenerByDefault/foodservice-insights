"""PDF report assembly for food reports."""

from __future__ import annotations

import logging
import re
import textwrap
from datetime import datetime
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import pandas as pd
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.figure import Figure
from matplotlib.font_manager import FontProperties
from matplotlib.textpath import text_to_path
from matplotlib.transforms import Bbox

from gbd_foodservice_insights.plotting_utils import close_new_figures_on_error
from gbd_foodservice_insights.report.food_report import FoodReport, ReportCharts
from gbd_foodservice_insights.report.quality import summarize_findings
from gbd_foodservice_insights.report.schema import quality_status_from_findings
from gbd_foodservice_insights.utils import rel_path

logger = logging.getLogger(__name__)

_TEXT_PAGE_TOP_Y = 0.88
_TEXT_PAGE_BOTTOM_Y = 0.06
_TEXT_PAGE_LINE_HEIGHT = 0.03
_TEXT_PAGE_WRAP_CHARS = 92

_SUMMARY_MARGIN_IN = 1.0
_SUMMARY_LINE_HEIGHT = 0.025


# ---------------------------------------------------------------------------
# PDF helpers
# ---------------------------------------------------------------------------


def _new_text_figure(fig_size: tuple[float, float] = (8.5, 11)) -> tuple[Figure, plt.Axes]:
    """Create a blank figure, with its single axes turned off, for rendering text or tables."""
    fig, ax = plt.subplots(figsize=fig_size)
    ax.axis("off")
    return fig, ax


def create_title_page(
    pdf: PdfPages,
    client: str,
    baseline_pilot: str,
    procurement_serving: str,
    fig_size: tuple[float, float] = (8.5, 11),
) -> None:
    """Render a branded title page in the PDF.

    ``baseline_pilot`` is the phase, e.g. ``"baseline"`` or ``"pilot"``.
    """
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
    ax.text(
        0.5,
        0.55,
        client.replace("_", " ").title(),
        transform=ax.transAxes,
        ha="center",
        va="center",
        fontsize=20,
        fontfamily="Montserrat",
    )
    subtitle_parts = [
        baseline_pilot.replace("_", " ").title(),
        procurement_serving.replace("_", " ").replace("-", " ").title(),
    ]
    ax.text(
        0.5,
        0.47,
        " | ".join(subtitle_parts),
        transform=ax.transAxes,
        ha="center",
        va="center",
        fontsize=14,
        fontfamily="Lato",
        color="gray",
    )
    ax.text(
        0.5,
        0.38,
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
    """Human-scale CO2e: tonnes above 2,000 kg, else kilograms."""
    if kg >= 2000:
        return f"{kg / 1000:,.0f} tonnes"
    return f"{kg:,.0f} kg"


def create_executive_summary_page(
    pdf: PdfPages,
    summary_stats: dict[str, Any],
    fig_size: tuple[float, float] = (8.5, 11),
    narrative: dict[str, Any] | None = None,
) -> None:
    """Render the executive summary page.

    Two modes:
    - ``narrative`` provided (web app / client-facing runs): a plain-English
      page written for readers who will never hear the report explained —
      a headline figure followed by short prose paragraphs.
    - ``narrative`` omitted (legacy callers): the original ``label: value``
      listing of ``summary_stats``, unchanged.

    ``narrative`` has keys ``client``, ``period``, ``total_food_kg``, ``total_co2e_kg``,
    ``per_dm_kg``, ``dm_label``, ``plant_pct``, ``animal_pct``, ``top_categories`` (list of
    ``(name, pct_of_footprint)``) and ``quality_status``.
    """
    fig, ax = _new_text_figure(fig_size)
    # Span the whole page, so axes coordinates are page coordinates: the default subplot
    # margins are lopsided, pushing left-aligned text off the right edge.
    ax.set_position((0, 0, 1, 1))
    text_width_in = fig_size[0] - 2 * _SUMMARY_MARGIN_IN
    left_x = _SUMMARY_MARGIN_IN / fig_size[0]

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

    if narrative is None:
        lines = []
        for label, value in summary_stats.items():
            lines.append(f"{label}:  {value}")

        y = 0.74
        for line in lines:
            ax.text(
                left_x,
                y,
                line,
                transform=ax.transAxes,
                ha="left",
                va="top",
                fontsize=12,
                fontfamily="Lato",
            )
            y -= 0.035

        pdf.savefig(fig)
        plt.close(fig)
        return

    # --- Plain-English mode -------------------------------------------------
    # Plain "CO2e" throughout: the report fonts (Montserrat/Lato) lack the
    # subscript-two glyph, which renders as a missing-character box.
    headline = _format_co2e(narrative["total_co2e_kg"])
    ax.text(
        0.5,
        0.76,
        f"{headline} CO2e",
        transform=ax.transAxes,
        ha="center",
        va="top",
        fontsize=34,
        fontweight="bold",
        fontfamily="Montserrat",
        color="#006a62",
    )
    subtitle = (
        f"the climate footprint of food purchased by {narrative['client']}, {narrative['period']}"
    )
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

    dm = narrative.get("dm_label", "diner")
    paragraphs = []

    sentence = (
        f"Over this period the kitchen purchased about {narrative['total_food_kg']:,.0f} kg "
        f"of categorised food. Producing that food released an estimated {headline} of carbon "
        "dioxide equivalent (CO2e), the standard measure for comparing the climate impact of "
        "different foods."
    )
    if narrative.get("per_dm_kg"):
        sentence += f" That works out at roughly {narrative['per_dm_kg']:.2f} kg of CO2e per {dm}."
    paragraphs.append(sentence)

    top = narrative.get("top_categories") or []
    if top:
        if len(top) >= 3:
            top_text = (
                f"{top[0][0]} ({top[0][1]:.0f}% of the food footprint), {top[1][0]} "
                f"({top[1][1]:.0f}%) and {top[2][0]} ({top[2][1]:.0f}%)"
            )
        else:
            top_text = " and ".join(f"{n} ({p:.0f}%)" for n, p in top)
        paragraphs.append(f"The biggest contributors were {top_text}.")

    if narrative.get("plant_pct") is not None:
        paragraphs.append(
            f"Plant-based items made up {narrative['plant_pct']:.0f}% of the categorised food "
            f"by weight, and animal products {narrative['animal_pct']:.0f}%. Animal products "
            "carry far higher emissions per kilogram, so a small number of categories drive "
            "most of the footprint. Modest, targeted menu changes in those areas deliver the "
            "largest reductions."
        )

    quality = str(narrative.get("quality_status", "")).lower()
    if quality and quality not in ("pass", "success"):
        paragraphs.append(
            "Some data-quality notes apply to this analysis; they are listed in plain "
            "language at the back of this report."
        )
    paragraphs.append(
        "The pages that follow show how the footprint breaks down by month, category and "
        "product. The methodology is explained at the back."
    )

    y -= 0.035  # gap below the subtitle
    for paragraph in paragraphs:
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


def create_text_page(
    pdf: PdfPages,
    title: str,
    content_lines: list[str],
    fig_size: tuple[float, float] = (8.5, 11),
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


def create_table_page(
    pdf: PdfPages,
    title: str,
    dataframe: pd.DataFrame,
    fig_size: tuple[float, float] = (11, 8.5),
) -> None:
    """Render a DataFrame as a styled table page in the PDF.

    Certain titles trigger custom layouts. Only the first 40 rows are rendered.
    """
    if title == "Decision KPIs":
        create_decision_kpis_page(pdf, dataframe)
        return

    fig, ax = _new_text_figure(fig_size)

    ax.text(
        0.5,
        0.97,
        title,
        transform=ax.transAxes,
        ha="center",
        va="top",
        fontsize=14,
        fontweight="bold",
        fontfamily="Montserrat",
    )

    # Truncate large tables for display
    display_df = dataframe.head(40).copy()
    col_widths = None

    if not isinstance(display_df.index, pd.RangeIndex) or display_df.index.name is not None:
        index_label = display_df.index.name or "Label"
        display_df = display_df.reset_index().rename(columns={"index": index_label})

    def _format_pdf_table_value(value: Any) -> Any:
        if pd.isna(value):
            return ""
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            numeric_value = float(value)
            if numeric_value.is_integer():
                return f"{int(numeric_value):,}"
            return f"{numeric_value:,.2f}".rstrip("0").rstrip(".")
        return value

    display_df = display_df.map(_format_pdf_table_value)

    if title == "Substitution Scenarios" and "Scenario" in display_df.columns:
        display_df = display_df.copy()
        display_df["Scenario"] = display_df["Scenario"].map(
            lambda value: (
                textwrap.fill(str(value), width=24, break_long_words=False, break_on_hyphens=False)
                if pd.notna(value)
                else value
            )
        )
        col_widths = [0.30, 0.17, 0.16, 0.16, 0.21]

    if display_df.empty:
        ax.text(
            0.5,
            0.5,
            "No data available.",
            transform=ax.transAxes,
            ha="center",
            va="center",
            fontsize=12,
            color="gray",
        )
        pdf.savefig(fig)
        plt.close(fig)
        return

    table = ax.table(
        cellText=display_df.values.tolist(),
        colLabels=[str(column) for column in display_df.columns],
        bbox=Bbox.from_bounds(0.03, 0.06, 0.94, 0.84),
        cellLoc="left",
        colWidths=col_widths,
    )
    table.auto_set_font_size(False)
    font_size = 7.5 if len(display_df.columns) <= 6 else 6.5
    if title == "Substitution Scenarios":
        font_size = 10.0
    if title == "Category Template":
        font_size += 2.0
    table.set_fontsize(font_size)
    row_scale = 1.18 if len(display_df.columns) <= 6 else 1.08
    if title == "Category Template":
        row_scale += 0.12
    if title == "Substitution Scenarios":
        row_scale += 0.12
    table.scale(1.0, row_scale)

    for (_, _), cell in table.get_celld().items():
        cell.get_text().set_wrap(True)
        cell.set_edgecolor("#D9E1EA")
        cell.set_linewidth(0.6)

    if title == "Substitution Scenarios" and "Scenario" in display_df.columns:
        scenario_col_idx = display_df.columns.get_loc("Scenario")
        line_counts = [str(value).count("\n") + 1 for value in display_df["Scenario"].tolist()]
        for row_idx, line_count in enumerate(line_counts, start=1):
            row_height = table[row_idx, 0].get_height() * max(1.15, 1 + 0.9 * (line_count - 1))
            for col_idx in range(len(display_df.columns)):
                table[row_idx, col_idx].set_height(row_height)
                table[row_idx, col_idx].set_text_props(va="top")
            table[row_idx, scenario_col_idx].set_text_props(fontsize=11.25, va="top")

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
    dataframe: pd.DataFrame,
    fig_size: tuple[float, float] = (8.5, 11),
) -> None:
    """Render the decision KPI as a narrative text page.

    ``dataframe`` is one row of decision-KPI fields.
    """
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

    if dataframe.empty:
        ax.text(
            0.5,
            0.5,
            "No data available.",
            transform=ax.transAxes,
            ha="center",
            va="center",
            fontsize=12,
            color="gray",
        )
        pdf.savefig(fig)
        plt.close(fig)
        return

    row = dataframe.iloc[0].to_dict()
    focus = str(row.get("Focus", "top animal products")).strip()
    share = row.get("Share of Animal Emissions (%)", "")
    top_products_emissions = row.get("Top Products Kg CO2e", "")
    top_products = str(row.get("Top Animal Products", "")).strip()

    def _clean_numeric_text(value: Any) -> str:
        if pd.isna(value):
            return ""
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            numeric_value = float(value)
            if numeric_value.is_integer():
                return f"{int(numeric_value):,}"
            return f"{numeric_value:,.1f}".rstrip("0").rstrip(".")
        return str(value).strip()

    share_text = _clean_numeric_text(share)
    emissions_text = _clean_numeric_text(top_products_emissions)

    product_list = [item.strip() for item in top_products.split(" | ") if item.strip()]
    if not product_list and top_products:
        product_list = [top_products]

    product_count = len(product_list)
    product_label = "product was" if product_count == 1 else "products were"

    intro_lines = _wrap_text_lines(
        [
            (f"The {focus.lower()} was {share_text}% amounting to {emissions_text} kg CO2e."),
            "",
            f"The top {product_count} animal {product_label}:",
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

    for idx, product in enumerate(product_list, start=1):
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

_QUALITY_STATUS_SENTENCES = {
    "pass": "All automated data checks passed — your data looks complete and consistent.",
    "warning": (
        "Your data passed most checks, but a few things are worth noting. See the details below."
    ),
    "invalid": (
        "One or more data issues were found that may affect the accuracy of these results. "
        "Please review the notes below before sharing this report."
    ),
}

_STATUS_LABELS = {
    "success": "\u2022 Passed",
    "info": "\u2022 Note",
    "warning": "\u2022 Warning",
    "error": "\u2022 Issue",
}


def _quality_to_lines(
    quality_status: str,
    quality_summary: dict[str, Any] | None,
    missing_data_findings: list[dict[str, Any]] | None,
    show_successes: bool = True,
) -> list[str]:
    """Turn quality-check results into plain lines for the PDF report.

    ``quality_status`` is ``"pass"``, ``"warning"``, or ``"invalid"``; ``quality_summary`` has
    a ``"by_status"`` count breakdown; each finding has ``status``/``message`` keys.
    """
    status_sentence = _QUALITY_STATUS_SENTENCES.get(
        quality_status.lower(),
        f"Data check result: {quality_status}.",
    )
    lines: list[str] = [
        (
            "This section summarises the automated checks run on your data before this report "
            "was produced."
        ),
        "",
        status_sentence,
    ]

    if quality_summary:
        by_status = quality_summary.get("by_status", {})
        n_pass = by_status.get("success", 0)
        n_info = by_status.get("info", 0)
        n_warn = by_status.get("warning", 0)
        n_err = by_status.get("error", 0)
        parts = []
        if n_pass:
            parts.append(f"{n_pass} passed")
        if n_info:
            parts.append(f"{n_info} note{'s' if n_info != 1 else ''}")
        if n_warn:
            parts.append(f"{n_warn} warning{'s' if n_warn != 1 else ''}")
        if n_err:
            parts.append(f"{n_err} issue{'s' if n_err != 1 else ''}")
        if parts:
            lines.append("  " + "  ·  ".join(parts))

    findings = missing_data_findings or []
    visible = [f for f in findings if show_successes or f.get("status") != "success"]

    if visible:
        lines.append("")
        lines.append("Check details:")
        for finding in visible[:20]:
            label = _STATUS_LABELS.get(finding.get("status", "info"), "•")
            lines.append(f"  {label}:  {finding.get('message', '')}")
            for sample_value in finding.get("sample_values", [])[:5]:
                lines.append(f"      - {sample_value}")
    else:
        lines.append("")
        lines.append("No issues were detected.")

    return lines


def _wrap_to_width(text: str, max_width_in: float, fontsize: float, fontfamily: str) -> list[str]:
    """Greedily wrap ``text`` so each line's rendered width fits within ``max_width_in``."""
    prop = FontProperties(family=fontfamily, size=fontsize)

    def width_in(line: str) -> float:
        width_pt, _, _ = text_to_path.get_text_width_height_descent(line, prop, ismath=False)
        return width_pt / 72

    lines: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}" if current else word
        if current and width_in(candidate) > max_width_in:
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


def _how_to_read_lines(diner_or_meal: str = "diner") -> list[str]:
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
        "because they account for differences in how many people were served each month.",
        "",
        "The plant vs. animal breakdown shows the proportion of food purchased from",
        "plant-based vs. animal-based sources. Shifting this ratio is one of the most",
        "effective ways to reduce your carbon footprint.",
        "",
        "The top driver products are the items most worth reviewing first when planning",
        "menu changes — they have the largest impact on your overall carbon figures.",
    ]


def _methodology_lines(diner_or_meal: str = "diner") -> list[str]:
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
            "of diners served."
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


def _format_animal_emissions_intensity_for_pdf(dataframe: pd.DataFrame) -> pd.DataFrame:
    """Return a PDF-friendly copy of the animal emissions table."""
    if dataframe.empty:
        return dataframe.copy()

    display_df = dataframe.copy()
    display_df = display_df.rename(
        columns={
            "category": "Category",
            "kilos_total": "Kilos of Food",
            "total_kg_co2e": "Kg CO2e Kg",
            "kg_co2e_per_kg_food": "CO2e Per Kg Food",
        }
    )

    ordered_columns = [
        column
        for column in ["Category", "Kilos of Food", "CO2e Per Kg Food", "Kg CO2e Kg"]
        if column in display_df.columns
    ]
    display_df = display_df[ordered_columns]

    for column in ["Kilos of Food", "Kg CO2e Kg"]:
        if column in display_df.columns:
            display_df[column] = display_df[column].round().astype("Int64")

    if "CO2e Per Kg Food" in display_df.columns:
        display_df["CO2e Per Kg Food"] = display_df["CO2e Per Kg Food"].round(2)

    return display_df


def _format_category_template_for_pdf(dataframe: pd.DataFrame) -> pd.DataFrame:
    """Return a PDF-friendly copy of the category template table."""
    if dataframe.empty:
        return dataframe.copy()

    def _format_label(value: object) -> object:
        if not isinstance(value, str):
            return value
        return value.replace("_", " ").title()

    display_df = dataframe.copy()
    display_df.columns = [_format_label(column) for column in display_df.columns]

    if display_df.index.name is not None:
        display_df.index = display_df.index.rename(_format_label(display_df.index.name))

    return display_df


def _format_decision_kpis_for_pdf(dataframe: pd.DataFrame) -> pd.DataFrame:
    """Return a compact, client-facing version of the decision KPI table."""
    if dataframe.empty:
        return dataframe.copy()

    display_df = dataframe.copy()
    display_df = display_df.rename(
        columns={
            "KPI": "Focus",
            "Value": "Share of Animal Emissions (%)",
            "Top products": "Top Animal Products",
            "Top product emissions (kg CO2e)": "Top Products Kg CO2e",
            "Total animal emissions (kg CO2e)": "Total Animal Kg CO2e",
        }
    )

    keep_columns = [
        "Focus",
        "Share of Animal Emissions (%)",
        "Top Animal Products",
        "Top Products Kg CO2e",
        "Total Animal Kg CO2e",
    ]
    display_df = display_df[[column for column in keep_columns if column in display_df.columns]]

    for column in [
        "Share of Animal Emissions (%)",
        "Top Products Kg CO2e",
        "Total Animal Kg CO2e",
    ]:
        if column in display_df.columns:
            rounded = pd.to_numeric(display_df[column], errors="coerce")
            if column == "Share of Animal Emissions (%)":
                display_df[column] = rounded.round(1)
            else:
                display_df[column] = rounded.round().astype("Int64")

    return display_df


def _format_substitution_scenarios_for_pdf(dataframe: pd.DataFrame) -> pd.DataFrame:
    """Return a narrower substitution-scenarios table for the PDF."""
    if dataframe.empty:
        return dataframe.copy()

    display_df = dataframe.copy()
    keep_columns = [
        "scenario",
        "replaced_weight_kg",
        "projected_emissions_kg_co2e",
        "avoidable_kg_co2e",
        "institution_emissions_avoided_pct",
    ]
    display_df = display_df[[column for column in keep_columns if column in display_df.columns]]
    display_df = display_df.rename(
        columns={
            "scenario": "Scenario",
            "replaced_weight_kg": "Weight Replaced (kg)",
            "projected_emissions_kg_co2e": "Projected Kg CO2e",
            "avoidable_kg_co2e": "Avoidable Kg CO2e",
            "institution_emissions_avoided_pct": "Institution Emissions Averted (%)",
        }
    )

    for column in [
        "Weight Replaced (kg)",
        "Projected Kg CO2e",
        "Avoidable Kg CO2e",
        "Institution Emissions Averted (%)",
    ]:
        if column in display_df.columns:
            numeric = pd.to_numeric(display_df[column], errors="coerce")
            if column == "Institution Emissions Averted (%)":
                display_df[column] = numeric.round(2)
            else:
                display_df[column] = numeric.round().astype("Int64")

    return display_df


# ---------------------------------------------------------------------------
# PDF builder
# ---------------------------------------------------------------------------


def build_pdf_report(
    output_path: str,
    title_info: dict[str, str],
    plots: list[tuple[str, Figure]],
    tables: dict[str, pd.DataFrame],
    summary_stats: dict[str, Any],
    quality_status: str = "pass",
    quality_summary: dict[str, Any] | None = None,
    missing_data_findings: list[dict[str, Any]] | None = None,
    show_quality_successes: bool = True,
    diner_or_meal: str = "diner",
    narrative: dict[str, Any] | None = None,
) -> str:
    """Assemble the full PDF report and return its absolute path.

    ``title_info`` has keys ``client``, ``baseline_pilot``, ``procurement_serving``. With
    ``show_quality_successes`` (notebook/data scientist mode), passed checks are shown in the
    quality section; without it (web app mode), only notes, warnings, and issues are shown.
    """
    output_path = str(Path(output_path).resolve())

    with close_new_figures_on_error(), PdfPages(output_path) as pdf:
        # 1. Title page
        create_title_page(
            pdf,
            client=title_info.get("client", ""),
            baseline_pilot=title_info.get("baseline_pilot", ""),
            procurement_serving=title_info.get("procurement_serving", ""),
        )

        # 2. Executive summary (plain-English when a narrative is supplied)
        create_executive_summary_page(pdf, summary_stats, narrative=narrative)

        # 3. How to read the charts
        create_text_page(pdf, "How to Read This Report", _how_to_read_lines(diner_or_meal))

        # 4. Plots
        for _caption, fig in plots:
            pdf.savefig(fig)

        # 5. Tables
        for table_title, df in tables.items():
            create_table_page(pdf, table_title, df)

        # 6. Methodology note
        create_text_page(
            pdf,
            "About This Report",
            _methodology_lines(diner_or_meal),
            bold_lines={
                "What is procurement data?",
                "How are carbon figures calculated?",
            },
        )

        # 7. Data quality status
        quality_lines = _quality_to_lines(
            quality_status=quality_status,
            quality_summary=quality_summary,
            missing_data_findings=missing_data_findings,
            show_successes=show_quality_successes,
        )
        create_text_page(pdf, "Data Completeness & Quality", quality_lines)

    logger.info("PDF report saved to %s", rel_path(output_path))
    return output_path


def write_report_pdf(
    report: FoodReport,
    charts: ReportCharts,
    path: Path,
    *,
    client_name: str,
    baseline_pilot: str,
    show_quality_successes: bool,
) -> None:
    findings = [*report.findings, *charts.findings]
    quality_status = quality_status_from_findings(findings)

    tables = {
        "Category Template": _format_category_template_for_pdf(report.aggregation["template_data"])
    }
    animal_emissions_intensity = report.procurement_table("animal_emissions_intensity")
    if animal_emissions_intensity is not None:
        tables["Animal Emissions Intensity"] = _format_animal_emissions_intensity_for_pdf(
            animal_emissions_intensity
        )
    decision_kpis = report.procurement_table("decision_kpis")
    if decision_kpis is not None:
        tables["Decision KPIs"] = _format_decision_kpis_for_pdf(decision_kpis)
    substitution_scenarios = report.procurement_table("substitution_scenarios")
    if substitution_scenarios is not None:
        tables["Substitution Scenarios"] = _format_substitution_scenarios_for_pdf(
            substitution_scenarios
        )

    build_pdf_report(
        output_path=str(path),
        title_info={
            "client": client_name,
            "baseline_pilot": baseline_pilot,
            "procurement_serving": report.mode,
        },
        plots=charts.figures,
        tables=tables,
        summary_stats={**report.summary_stats, "Data Quality Status": quality_status.upper()},
        quality_status=quality_status,
        quality_summary=summarize_findings(findings),
        missing_data_findings=findings,
        show_quality_successes=show_quality_successes,
        diner_or_meal=report.diner_or_meal,
        narrative=_executive_narrative(report, client_name, quality_status),
    )


def _executive_narrative(
    report: FoodReport, client_name: str, quality_status: str
) -> dict[str, Any] | None:
    """The plain-English executive summary. Only procurement runs compute emissions; the rest
    keep the key-value summary page."""
    emissions_summary = report.emissions_summary
    if emissions_summary is None or "total_kg_co2e" not in emissions_summary:
        return None
    co2e_by_cat = emissions_summary.dropna(subset=["total_kg_co2e"])
    total_co2e = float(co2e_by_cat["total_kg_co2e"].sum(min_count=1) or 0.0)
    if not total_co2e > 0:  # NaN too
        return None

    total_dm = report.total_diner_meals
    split = report.plant_animal_split
    top = co2e_by_cat.nlargest(3, "total_kg_co2e")
    return {
        "client": client_name,
        "period": report.summary_stats.get("Date range", ""),
        "total_food_kg": float(report.rows[report.metric_total].sum()),
        "total_co2e_kg": total_co2e,
        "per_dm_kg": (total_co2e / total_dm) if total_dm else None,
        "dm_label": report.diner_or_meal,
        "plant_pct": split["plant_pct"] if split is not None else None,
        "animal_pct": split["animal_pct"] if split is not None else None,
        "top_categories": [
            (str(row["category"]), 100 * row["total_kg_co2e"] / total_co2e)
            for _, row in top.iterrows()
        ],
        "quality_status": quality_status,
    }
