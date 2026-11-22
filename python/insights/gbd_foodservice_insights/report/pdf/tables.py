"""The report's table pages, each sized so every cell renders unclipped."""

import matplotlib.pyplot as plt
import pandas as pd
from matplotlib.font_manager import FontProperties
from matplotlib.table import Cell, Table
from matplotlib.transforms import Bbox

from gbd_foodservice_insights.plotting_utils import (
    BODY_FONT,
    GBD_BORDER,
    GBD_CREAM,
    GBD_GREEN,
    GBD_SAND,
    LETTER_LANDSCAPE,
    TITLE_FONT,
)
from gbd_foodservice_insights.report.pdf.layout import (
    PdfSink,
    new_text_figure,
    text_width_in,
    wrap_to_width,
)

_TABLE_BBOX = Bbox.from_bounds(0.03, 0.06, 0.94, 0.84)
# The substitution scenarios' names are drawn larger than the rest of their table.
_MULTILINE_FONT_SIZE = 11.25


def create_category_template_pages(
    pdf: PdfSink,
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


def create_animal_intensity_page(pdf: PdfSink, intensity: pd.DataFrame) -> None:
    display_df = _display_table(_format_animal_emissions_intensity_for_pdf(intensity))
    font_size = 10.0
    # Each column gets the width its text needs, and an equal share of what is left.
    widths = _table_column_widths_in(display_df, font_size)
    slack = (_table_width_in(LETTER_LANDSCAPE) - sum(widths)) / len(widths)
    _draw_table_page(
        pdf,
        "Animal Emissions Intensity",
        display_df,
        col_widths=[width + slack for width in widths],
        font_size=font_size,
        row_scale=1.18,
    )


def create_substitution_scenarios_page(pdf: PdfSink, scenarios: pd.DataFrame) -> None:
    display_df = _display_table(_format_substitution_scenarios_for_pdf(scenarios))
    col_widths = [0.30, 0.17, 0.16, 0.16, 0.21]
    font_size = 10.0
    # The share of each column a cell's text may fill, as `_table_column_widths_in` reckons it.
    text_widths_in = [
        width * _table_width_in(LETTER_LANDSCAPE) * (1 - 2 * Cell.PAD) for width in col_widths
    ]
    display_df["Scenario"] = display_df["Scenario"].map(
        lambda value: "\n".join(
            wrap_to_width(
                value, text_widths_in[0], fontsize=_MULTILINE_FONT_SIZE, fontfamily=BODY_FONT
            )
        )
    )
    display_df.columns = [
        "\n".join(
            wrap_to_width(
                column, width_in, fontsize=font_size, fontfamily=BODY_FONT, fontweight="bold"
            )
        )
        for column, width_in in zip(display_df.columns, text_widths_in, strict=True)
    ]
    _draw_table_page(
        pdf,
        "Substitution Scenarios",
        display_df,
        col_widths=col_widths,
        font_size=font_size,
        row_scale=1.30,
        multiline_column="Scenario",
    )


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

    # The row of totals is the only row label that is not a category name, which stays as is.
    display_df = template.rename(index={"total": "Total"})
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
    """The width of `_TABLE_BBOX` on a `new_text_figure` page, whose axes `plt.subplots`
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
            text_width_in(str(column), header),
            *(text_width_in(str(value), body) for value in display_df.iloc[:, index]),
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
    pdf: PdfSink,
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
    fig, ax = new_text_figure(fig_size)

    ax.text(
        0.5,
        0.97,
        heading,
        transform=ax.transAxes,
        ha="center",
        va="top",
        fontsize=14,
        fontweight="bold",
        fontfamily=TITLE_FONT,
        color=GBD_GREEN,
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
        cell.set_edgecolor(GBD_BORDER)
        cell.set_linewidth(0.6)

    # A cell centers its text on the row whatever its `va`, so a row fits more lines only by
    # growing.
    if multiline_column is not None:
        multiline_col_idx = list(display_df.columns).index(multiline_column)
        line_counts = [value.count("\n") + 1 for value in display_df[multiline_column]]
        for row_idx, line_count in enumerate(line_counts, start=1):
            _scale_row_height(table, row_idx, len(display_df.columns), line_count)
            table[row_idx, multiline_col_idx].set_text_props(fontsize=_MULTILINE_FONT_SIZE)

    header_lines = max(str(column).count("\n") + 1 for column in display_df.columns)
    _scale_row_height(table, 0, len(display_df.columns), header_lines)
    for col_idx in range(len(display_df.columns)):
        cell = table[0, col_idx]
        cell.set_facecolor(GBD_GREEN)
        cell.set_text_props(color=GBD_CREAM, fontweight="bold")
        cell.set_edgecolor(GBD_GREEN)
        cell.set_linewidth(0.8)

    for row_idx in range(1, len(display_df) + 1):
        for col_idx in range(len(display_df.columns)):
            cell = table[row_idx, col_idx]
            if row_idx % 2 == 0:
                cell.set_facecolor(GBD_SAND)
            else:
                cell.set_facecolor("white")

    pdf.savefig(fig)
    plt.close(fig)


def _scale_row_height(table: Table, row_idx: int, column_count: int, line_count: int) -> None:
    row_height = table[row_idx, 0].get_height() * max(1.15, 1 + 0.9 * (line_count - 1))
    for col_idx in range(column_count):
        table[row_idx, col_idx].set_height(row_height)
