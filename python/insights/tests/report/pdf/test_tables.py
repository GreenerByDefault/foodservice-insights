import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights.report.aggregation import category_names
from gbd_foodservice_insights.report.pdf.tables import (
    _display_table,
    _format_animal_emissions_intensity_for_pdf,
    _format_category_template_for_pdf,
    _format_substitution_scenarios_for_pdf,
    _pack_columns,
    create_animal_intensity_page,
    create_category_template_pages,
    create_substitution_scenarios_page,
)
from matplotlib.figure import Figure
from matplotlib.transforms import Bbox


class _RecordingTablePdf:
    """Stands in for ``PdfPages``, keeping each table page's heading, column labels, and the
    cells whose text runs past the cell's right, top or bottom edge."""

    def __init__(self) -> None:
        self.headings: list[str] = []
        self.columns: list[list[str]] = []
        self.overflowing: list[str] = []
        self.scenario_cells: list[str] = []

    def savefig(self, fig: Figure) -> None:
        fig.canvas.draw()  # lays the table out
        renderer = fig.canvas.get_renderer()  # ty: ignore[missing-attribute]
        (ax,) = fig.axes
        (table,) = ax.tables
        cells = table.get_celld()
        self.headings.append(ax.texts[0].get_text())
        self.columns.append(
            [cells[0, col].get_text().get_text() for col in range(max(c for _, c in cells) + 1)]
        )
        self.scenario_cells += [
            cells[row, 0].get_text().get_text() for row in range(1, max(r for r, _ in cells) + 1)
        ]
        self.overflowing += [
            cell.get_text().get_text()
            for cell in cells.values()
            if _overflows(
                cell.get_text().get_window_extent(renderer), cell.get_window_extent(renderer)
            )
        ]


def _overflows(text: Bbox, cell: Bbox) -> bool:
    return text.x1 > cell.x1 or text.y1 > cell.y1 or text.y0 < cell.y0


@pytest.mark.parametrize("months", [3, 6, 12, 24])
def test_category_template_fits_every_cell_and_splits_months_across_pages(months: int) -> None:
    month_labels = [str(month) for month in pd.period_range("2024-01", periods=months, freq="M")]
    template = pd.DataFrame(
        123_456.78,
        index=pd.Index([*category_names(), "total"], name="category"),
        columns=[*month_labels, "total"],
    )

    pdf = _RecordingTablePdf()
    create_category_template_pages(pdf, template)

    assert pdf.overflowing == []
    assert all(columns[0] == "Category" for columns in pdf.columns)
    assert [label for columns in pdf.columns for label in columns[1:]] == [*month_labels, "Total"]
    pages = len(pdf.headings)
    assert (pages > 1) == (months >= 12)
    assert pdf.headings == (
        ["Category Template"]
        if pages == 1
        else [f"Category Template ({page} of {pages})" for page in range(1, pages + 1)]
    )


def test_animal_intensity_page_fits_every_category_name() -> None:
    categories = category_names()
    intensity = pd.DataFrame(
        {
            "category": categories,
            "kilos_total": [123_456.0] * len(categories),
            "kg_co2e_per_kg_food": [41.35] * len(categories),
            "total_kg_co2e": [1_234_567.0] * len(categories),
        }
    )
    pdf = _RecordingTablePdf()

    create_animal_intensity_page(pdf, intensity)

    assert pdf.headings == ["Animal Emissions Intensity"]
    assert pdf.overflowing == []


def test_pack_columns_gives_an_overwide_column_its_own_page() -> None:
    assert _pack_columns([1.0, 1.0, 3.0, 1.0], 2.5) == [[0, 1], [2], [3]]
    assert _pack_columns([], 2.5) == [[]]


def test_pack_columns_fills_a_page_exactly_before_starting_another() -> None:
    assert _pack_columns([1.0, 1.5, 1.0], 2.5) == [[0, 1], [2]]


# ----------------------------------------------------------------------
# Tests for the PDF table formatters
# ----------------------------------------------------------------------


def test_format_animal_emissions_intensity_renames_orders_and_rounds() -> None:
    table = pd.DataFrame(
        {
            "category": ["Beef and Buffalo Meat"],
            "kilos_total": [22.4],
            "total_kg_co2e": [909.7],
            "kg_co2e_per_kg_food": [41.3549],
        }
    )

    pd.testing.assert_frame_equal(
        _format_animal_emissions_intensity_for_pdf(table),
        pd.DataFrame(
            {
                "Category": ["Beef and Buffalo Meat"],
                "Kilos of Food": pd.array([22], dtype="Int64"),
                "CO₂e Per Kg Food": [41.35],
                "Kg CO₂e": pd.array([910], dtype="Int64"),
            }
        ),
    )


def test_format_category_template_titles_string_labels_only() -> None:
    table = pd.DataFrame(
        {"2024-01": [10.0], "grand_total": [10.0], 7: [1.0]},
        index=pd.Index(["Beef and Buffalo Meat"], name="category"),
    )

    pd.testing.assert_frame_equal(
        _format_category_template_for_pdf(table),
        pd.DataFrame(
            {"2024-01": [10.0], "Grand Total": [10.0], 7: [1.0]},
            index=pd.Index(["Beef and Buffalo Meat"], name="Category"),
        ),
    )


def test_format_category_template_capitalizes_the_total_row_only() -> None:
    table = pd.DataFrame(
        {"2024-01": [10.0, 10.0]},
        index=pd.Index(["Lamb/mutton & goat meat", "total"], name="category"),
    )

    assert _format_category_template_for_pdf(table).index.tolist() == [
        "Lamb/mutton & goat meat",
        "Total",
    ]


def test_format_category_template_leaves_an_unnamed_index_unnamed() -> None:
    table = pd.DataFrame({"total": [10.0]}, index=["Legumes"])

    pd.testing.assert_frame_equal(
        _format_category_template_for_pdf(table),
        pd.DataFrame({"Total": [10.0]}, index=["Legumes"]),
    )


def test_format_substitution_scenarios_drops_internal_columns_and_rounds() -> None:
    table = pd.DataFrame(
        {
            "scenario": ["10% ruminant-to-legume swap"],
            "substitution_pct": [10.0],
            "replaced_weight_kg": [2.2],
            "projected_emissions_kg_co2e": [822.25],
            "avoidable_kg_co2e": [87.45],
            "institution_emissions_avoided_pct": [9.0149],
        }
    )

    pd.testing.assert_frame_equal(
        _format_substitution_scenarios_for_pdf(table),
        pd.DataFrame(
            {
                "Scenario": ["10% ruminant-to-legume swap"],
                "Weight Replaced (kg)": pd.array([2], dtype="Int64"),
                "Projected Kg CO₂e": pd.array([822], dtype="Int64"),
                "Avoidable Kg CO₂e": pd.array([87], dtype="Int64"),
                "Institution Emissions Averted (%)": [9.01],
            }
        ),
    )


def test_display_table_formats_cells_as_text_and_surfaces_a_named_index() -> None:
    table = pd.DataFrame(
        {"n": [1234567.0, 2.5, 0.126, np.nan], "s": ["a", "b", "c", "d"], "flag": [True] * 4},
        index=pd.Index(["w", "x", "y", "z"], name="Category"),
    )

    assert _display_table(table).values.tolist() == [
        ["w", "1,234,567", "a", True],
        ["x", "2.5", "b", True],
        ["y", "0.13", "c", True],
        ["z", "", "d", True],
    ]


def test_substitution_scenarios_page_wraps_long_scenarios_and_headers_inside_their_cells() -> None:
    # Six rows, as the report has: fewer leave the table room to hide a row's overflow.
    long_scenario = "100% cow's-milk-to-oat-milk swap with a long name"
    scenarios = pd.DataFrame(
        {
            "scenario": [long_scenario] * 5 + ["10% swap"],
            "replaced_weight_kg": [10.0] * 6,
            "projected_emissions_kg_co2e": [800.0] * 6,
            "avoidable_kg_co2e": [100.0] * 6,
            "institution_emissions_avoided_pct": [11.1] * 6,
        }
    )
    pdf = _RecordingTablePdf()

    create_substitution_scenarios_page(pdf, scenarios)

    assert pdf.headings == ["Substitution Scenarios"]
    assert pdf.overflowing == []
    wrapped, *_, short = pdf.scenario_cells
    assert "\n" in wrapped
    assert wrapped.replace("\n", " ") == long_scenario
    assert short == "10% swap"
    assert "\n" in pdf.columns[0][-1]
