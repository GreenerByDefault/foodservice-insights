from contextlib import nullcontext
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights.report import pdf as pdf_module
from gbd_foodservice_insights.report.aggregation import AnimalEmissionsConcentration, category_names
from gbd_foodservice_insights.report.food_report import FoodReport, ReportCharts, build_food_report
from gbd_foodservice_insights.report.pdf import (
    CategoryShare,
    Co2ePerHead,
    ExecutiveNarrative,
    _display_table,
    _executive_narrative,
    _format_animal_emissions_intensity_for_pdf,
    _format_category_template_for_pdf,
    _format_co2e,
    _format_substitution_scenarios_for_pdf,
    _narrative_paragraphs,
    _pack_columns,
    _wrap_text_lines,
    _wrap_to_width,
    create_category_template_pages,
    create_decision_kpis_page,
    create_executive_summary_page,
    create_substitution_scenarios_page,
    create_text_page,
    create_title_page,
    quality_lines,
    write_report_pdf,
)
from gbd_foodservice_insights.report.quality import Finding, make_finding
from gbd_foodservice_insights.report.schema import DiagnosticStatus, DinerOrMeal, Headcounts
from matplotlib.figure import Figure
from matplotlib.font_manager import FontProperties
from matplotlib.textpath import text_to_path
from PyPDF2 import PdfReader

JAN, FEB = pd.period_range("2024-01", periods=2, freq="M")


def test_wrap_text_lines_hangs_wrapped_text_under_its_bullet() -> None:
    wrapped = _wrap_text_lines(
        [
            "  • Warning: Found 1716 rows that are exact duplicates across the key report "
            "fields and the text needs to wrap onto another visual row to avoid collisions.",
            "      - Eggs Medium Av51g on 2024-07-01 00:00:00 appears 149 times and should "
            "also wrap cleanly.",
        ],
        width=60,
    )

    assert wrapped == [
        "  • Warning: Found 1716 rows that are exact duplicates",
        "    across the key report fields and the text needs to wrap",
        "    onto another visual row to avoid collisions.",
        "      - Eggs Medium Av51g on 2024-07-01 00:00:00 appears 149",
        "        times and should also wrap cleanly.",
    ]


def test_wrap_text_lines_keeps_indentation_and_collapses_blank_lines() -> None:
    assert _wrap_text_lines(["  indented", "", "   ", "x"]) == ["  indented", "", "", "x"]
    assert _wrap_text_lines([]) == [""]


def test_wrap_to_width_fits_measured_width_without_losing_words() -> None:
    text = "Producing that food released an estimated 1,931 kg of carbon dioxide equivalent " * 3

    lines = _wrap_to_width(text, max_width_in=3.0, fontsize=11.5, fontfamily="Lato")

    assert len(lines) > 1
    assert " ".join(lines) == " ".join(text.split())
    assert all(
        text_to_path.get_text_width_height_descent(
            line, FontProperties(family="Lato", size=11.5), ismath=False
        )[0]
        <= 3.0 * 72
        for line in lines
    )


def test_wrap_to_width_keeps_an_overlong_word_on_its_own_line() -> None:
    assert _wrap_to_width("a " + "x" * 200 + " b", 1.0, fontsize=12, fontfamily="Lato") == [
        "a",
        "x" * 200,
        "b",
    ]
    assert _wrap_to_width("   ", 1.0, fontsize=12, fontfamily="Lato") == []


def _finding(
    status: DiagnosticStatus, message: str, *, sample_values: list[str] | None = None
) -> Finding:
    return make_finding(
        stage="test",
        category="date_distribution",
        status=status,
        message=message,
        sample_values=sample_values,
    )


@dataclass(frozen=True)
class _PageText:
    text: str
    y: float
    bold: bool


class _RecordingPdf:
    """Stands in for ``PdfPages``, keeping each page's text instead of writing a file."""

    def __init__(self) -> None:
        self.pages: list[list[_PageText]] = []

    def savefig(self, fig: Figure) -> None:
        self.pages.append(
            [
                _PageText(t.get_text(), t.get_position()[1], t.get_fontweight() == "bold")
                for ax in fig.axes
                for t in ax.texts
            ]
        )


@pytest.fixture
def recording_pdf(monkeypatch: pytest.MonkeyPatch) -> _RecordingPdf:
    pdf = _RecordingPdf()
    monkeypatch.setattr(pdf_module, "PdfPages", lambda _path: nullcontext(pdf))
    return pdf


def _page_titles(pdf: _RecordingPdf) -> list[str]:
    """Each page's first text, which is its title; a chart page has none."""
    return [page[0].text if page else "" for page in pdf.pages]


def _report(
    animal_product: tuple[str, str] | None = ("Ground Beef", "Beef and Buffalo Meat"),
    **overrides: Any,
) -> FoodReport:
    """Two months of lentils, alongside ``animal_product`` (its name and category) or, without
    one, chickpeas."""
    kwargs: dict[str, Any] = {
        "headcounts": Headcounts("diner", {JAN: 100, FEB: 120}),
        "region": "us",
        "top_n_drivers": 5,
    }
    product, category = animal_product or ("Chickpeas", "Legumes")
    rows = pd.DataFrame(
        {
            "date": pd.to_datetime(["2024-01-15", "2024-01-20", "2024-02-15", "2024-02-20"]),
            "product": [product, "Lentils", product, "Lentils"],
            "category": [category, "Legumes", category, "Legumes"],
            "kilos_total": [10.0, 20.0, 12.0, 18.0],
        }
    )
    return build_food_report(rows, **(kwargs | overrides))


def _write(
    report: FoodReport, path: Path = Path("report.pdf"), charts: ReportCharts | None = None
) -> None:
    write_report_pdf(
        report,
        charts or ReportCharts(figures=[]),
        path,
        client_name="Acme",
        show_quality_successes=False,
    )


def _title_page(client: str) -> list[_PageText]:
    pdf = _RecordingPdf()
    create_title_page(pdf, client, "Procurement")  # ty: ignore[invalid-argument-type]
    return pdf.pages[0]


def test_title_page_shows_the_client_name_as_typed() -> None:
    assert [t.text for t in _title_page("McDonald's")][:3] == [
        "Food Report",
        "McDonald's",
        "Procurement",
    ]


def test_title_page_wraps_a_long_client_name_above_the_subtitle() -> None:
    client = (
        "The University of Somewhere Hospitality and Conference Services — "
        "North Campus Main Dining Hall"
    )
    texts = _title_page(client)
    name_lines, subtitle, generated = texts[1:-3], texts[-3], texts[-2]
    prop = FontProperties(family="Montserrat", size=20)

    assert len(name_lines) > 1
    assert " ".join(t.text for t in name_lines) == client
    for line in name_lines:
        width_pt, _, _ = text_to_path.get_text_width_height_descent(line.text, prop, ismath=False)
        assert width_pt / 72 <= 6.5
    assert name_lines[-1].y > subtitle.y > generated.y


def test_title_page_replaces_underscores_in_the_client_name() -> None:
    assert [t.text for t in _title_page("acme_corp")][1] == "acme corp"


def _text_page_titles(lines: list[str], bold_lines: set[str] | None = None) -> list[str]:
    pdf = _RecordingPdf()
    create_text_page(pdf, "Title", lines, bold_lines=bold_lines)  # ty: ignore[invalid-argument-type]
    return _page_titles(pdf)


@pytest.mark.parametrize(
    ("line_count", "titles"),
    [
        (0, ["Title"]),
        (28, ["Title"]),
        (29, ["Title", "Title (cont.)"]),
        (56, ["Title", "Title (cont.)"]),
        (57, ["Title", "Title (cont.)", "Title (cont.)"]),
    ],
)
def test_text_page_fits_28_lines_per_page(line_count: int, titles: list[str]) -> None:
    assert _text_page_titles([f"line {i}" for i in range(line_count)]) == titles


def test_text_page_bolds_lines_compared_after_stripping() -> None:
    pdf = _RecordingPdf()

    create_text_page(
        pdf,  # ty: ignore[invalid-argument-type]
        "Title",
        ["  Heading?", "", "body"],
        bold_lines={"Heading?  "},
    )

    assert [(t.text, t.bold) for t in pdf.pages[0]] == [
        ("Title", True),
        ("  Heading?", True),
        ("", False),
        ("body", False),
    ]


def _summary_page(narrative: ExecutiveNarrative) -> list[_PageText]:
    pdf = _RecordingPdf()
    create_executive_summary_page(pdf, narrative)  # ty: ignore[invalid-argument-type]
    return pdf.pages[0]


def test_executive_summary_page_leads_with_the_headline_and_fits_the_page() -> None:
    narrative = _narrative(client="The University of Somewhere Hospitality and Conference Services")

    texts = _summary_page(narrative)

    assert [t.text for t in texts[:2]] == ["Executive Summary", "2.5 tonnes CO₂e"]
    assert texts[2].text.startswith("the climate footprint of food purchased by The University")
    assert " ".join(t.text for t in texts).endswith("The methodology is explained at the back.")
    assert all(t.y > 0 for t in texts)
    ys = [t.y for t in texts[2:]]
    assert ys == sorted(ys, reverse=True)


# ----------------------------------------------------------------------
# Tests for write_report_pdf
# ----------------------------------------------------------------------


def test_write_report_pdf_orders_the_procurement_pages(recording_pdf: _RecordingPdf) -> None:
    fig = plt.figure()

    _write(_report(), charts=ReportCharts(figures=[fig]))
    plt.close(fig)

    assert _page_titles(recording_pdf) == [
        "Food Report",
        "Executive Summary",
        "Data Completeness & Quality",
        "How to Read This Report",
        "",
        "Category Template",
        "Animal Emissions Intensity",
        "Decision KPIs",
        "Substitution Scenarios",
        "About This Report",
    ]


@pytest.mark.parametrize(
    ("animal_product", "procurement_pages"),
    [
        (None, []),
        (("Cheddar", "Cheese"), ["Animal Emissions Intensity", "Decision KPIs"]),
        (
            ("Whole Milk", "Milk (Cow's milk)"),
            ["Animal Emissions Intensity", "Decision KPIs", "Substitution Scenarios"],
        ),
    ],
    ids=["plant-only", "no-swap", "milk-swap"],
)
def test_write_report_pdf_includes_each_procurement_page_its_data_supports(
    recording_pdf: _RecordingPdf,
    animal_product: tuple[str, str] | None,
    procurement_pages: list[str],
) -> None:
    _write(_report(animal_product))

    titles = _page_titles(recording_pdf)
    assert titles[titles.index("Category Template") + 1 : -1] == procurement_pages


def test_write_report_pdf_continues_a_long_quality_section_onto_more_pages(
    recording_pdf: _RecordingPdf,
) -> None:
    long_finding = _finding(
        "warning",
        "Found duplicate line items across the report fields. This explanatory sentence is "
        "intentionally long so the rendered PDF needs multiple wrapped rows for each finding.",
        sample_values=["Eggs Medium Av51g on 2024-07-01 appears 149 times."] * 5,
    )

    _write(replace(_report(), findings=(long_finding,) * 12))

    titles = _page_titles(recording_pdf)
    start = titles.index("Data Completeness & Quality")
    assert titles[start + 1 : start + 4] == ["Data Completeness & Quality (cont.)"] * 3
    assert titles[start + 4] == "How to Read This Report"


def test_write_report_pdf_closes_its_own_figures_when_a_page_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = set(plt.get_fignums())
    fig = plt.figure()

    def _boom(*_args: object, **_kwargs: object) -> None:
        plt.figure()
        raise RuntimeError("boom")

    monkeypatch.setattr(pdf_module, "create_executive_summary_page", _boom)

    with pytest.raises(RuntimeError, match="boom"):
        _write(_report(), tmp_path / "report.pdf", ReportCharts(figures=[fig]))

    assert set(plt.get_fignums()) == before | {fig.number}
    plt.close(fig)


def test_write_report_pdf_leaves_the_callers_plots_open(tmp_path: Path) -> None:
    before = set(plt.get_fignums())
    fig = plt.figure()

    _write(_report(), tmp_path / "report.pdf", ReportCharts(figures=[fig]))

    assert set(plt.get_fignums()) == before | {fig.number}
    plt.close(fig)


def test_about_page_bolds_every_heading(recording_pdf: _RecordingPdf) -> None:
    _write(_report())

    (about,) = [
        page for page in recording_pdf.pages if page and page[0].text == "About This Report"
    ]
    assert [t.text for t in about[1:] if t.bold] == [
        "What is procurement data?",
        "How are carbon figures calculated?",
        "How should I interpret the monthly figures?",
        "How should I use this report?",
    ]


def _how_to_read_and_about_text(pdf: _RecordingPdf) -> str:
    """Both pages' words, joined by single spaces, so a phrase matches across line breaks."""
    return " ".join(
        word
        for page in pdf.pages
        if page and page[0].text in {"How to Read This Report", "About This Report"}
        for t in page
        for word in t.text.split()
    )


@pytest.mark.parametrize("diner_or_meal", ["diner", "meal"])
def test_text_pages_normalise_by_the_counts_basis(
    recording_pdf: _RecordingPdf, diner_or_meal: DinerOrMeal
) -> None:
    _write(_report(headcounts=Headcounts(diner_or_meal, {JAN: 100, FEB: 120})))

    text = _how_to_read_and_about_text(recording_pdf)
    assert f"how many {diner_or_meal}s were served each month" in text
    assert f"the number of {diner_or_meal}s served" in text
    assert "people" not in text


def test_text_pages_without_headcounts_say_every_figure_is_a_total(
    recording_pdf: _RecordingPdf,
) -> None:
    _write(_report(headcounts=None))

    text = _how_to_read_and_about_text(recording_pdf)
    assert (
        "Every figure in this report is a total. Totals rise and fall with how many people you "
        "serve, so compare months with that in mind."
    ) in text
    assert "per diner" not in text.lower()
    assert "normalising" not in text


@pytest.mark.parametrize(
    ("extra_status", "caveat_shown"),
    [(None, False), ("info", False), ("warning", True)],
)
def test_write_report_pdf_caveats_only_a_warning(
    tmp_path: Path, extra_status: DiagnosticStatus | None, caveat_shown: bool
) -> None:
    report = _report()
    findings = tuple(f for f in report.findings if f["status"] == "success")
    if extra_status is not None:
        findings += (_finding(extra_status, "Extra finding"),)
    path = tmp_path / "report.pdf"

    _write(replace(report, findings=findings), path)

    pages = ["".join((page.extract_text() or "").split()) for page in PdfReader(str(path)).pages]
    assert ("Somedata-qualitynotesapply" in pages[1]) is caveat_shown
    assert ("Extrafinding" in pages[2]) is caveat_shown
    assert ("Allautomateddatacheckspassed" in pages[2]) is not caveat_shown


def test_quality_lines_explain_an_invalid_status() -> None:
    assert quality_lines(
        [
            _finding("success", "All required columns present."),
            _finding("error", "Found 2 negative values in 'kilos_total'."),
        ],
        show_successes=True,
    ) == [
        "This section summarises the automated checks run on your data before this report "
        "was produced.",
        "",
        "One or more data issues were found that may affect the accuracy of these results. "
        "Please review the notes below before sharing this report.",
        "  1 passed  ·  1 issue",
        "",
        "Check details:",
        "  • Passed:  All required columns present.",
        "  • Issue:  Found 2 negative values in 'kilos_total'.",
    ]


def test_quality_lines_for_the_customer_list_only_warnings_and_issues() -> None:
    assert quality_lines(
        [
            _finding("success", "All required columns present."),
            _finding("info", "GBD categories absent from data: ['Butter']"),
            _finding("warning", "Found 1 month with a large swing."),
        ],
        show_successes=False,
    ) == [
        "This section summarises the automated checks run on your data before this report "
        "was produced.",
        "",
        "Your data passed most checks, but a few things are worth noting. See the details below.",
        "  1 passed  ·  1 warning",
        "",
        "Check details:",
        "  • Warning:  Found 1 month with a large swing.",
    ]


def test_quality_lines_for_the_customer_say_so_when_every_check_passed() -> None:
    assert quality_lines(
        [_finding("success", "All required columns present."), _finding("info", "A note.")],
        show_successes=False,
    ) == [
        "This section summarises the automated checks run on your data before this report "
        "was produced.",
        "",
        "All automated data checks passed — your data looks complete and consistent.",
        "  1 passed",
        "",
        "No issues were detected.",
    ]


def test_quality_lines_list_at_most_20_findings_with_5_samples_each() -> None:
    findings = [
        _finding("warning", f"Warning {i}", sample_values=[f"sample {j}" for j in range(7)])
        for i in range(25)
    ]

    lines = quality_lines(findings, show_successes=True)

    assert lines[3] == "  25 warnings"
    details = lines[lines.index("Check details:") + 1 :]
    assert details[:6] == [
        "  • Warning:  Warning 0",
        *(f"      - sample {j}" for j in range(5)),
    ]
    assert len(details) == 20 * 6


def test_quality_lines_count_notes_for_the_data_scientist_with_singular_and_plural() -> None:
    def counts(*findings: Finding) -> str:
        return quality_lines(list(findings), show_successes=True)[3]

    assert counts(_finding("info", "a")) == "  1 note"
    assert counts(_finding("info", "a"), _finding("info", "b")) == "  2 notes"


def test_quality_lines_with_no_findings_say_nothing_was_detected() -> None:
    assert quality_lines([], show_successes=True)[2:] == [
        "All automated data checks passed — your data looks complete and consistent.",
        "",
        "No issues were detected.",
    ]


class _RecordingTablePdf:
    """Stands in for ``PdfPages``, keeping each table page's heading, column labels, and the
    cells whose text runs past the cell's right edge."""

    def __init__(self) -> None:
        self.headings: list[str] = []
        self.columns: list[list[str]] = []
        self.overflowing: list[str] = []
        self.scenario_cells: list[str] = []

    def savefig(self, fig: Figure) -> None:
        fig.canvas.draw()  # lays the table out
        renderer = fig.canvas.get_renderer()  # ty: ignore[unresolved-attribute]
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
            if cell.get_text().get_window_extent(renderer).x1 > cell.get_window_extent(renderer).x1
        ]


@pytest.mark.parametrize("months", [3, 6, 12, 24])
def test_category_template_fits_every_cell_and_splits_months_across_pages(months: int) -> None:
    month_labels = [str(month) for month in pd.period_range("2024-01", periods=months, freq="M")]
    template = pd.DataFrame(
        123_456.78,
        index=pd.Index([*category_names(), "total"], name="category"),
        columns=[*month_labels, "total"],
    )

    pdf = _RecordingTablePdf()
    create_category_template_pages(pdf, template)  # ty: ignore[invalid-argument-type]

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


def test_pack_columns_gives_an_overwide_column_its_own_page() -> None:
    assert _pack_columns([1.0, 1.0, 3.0, 1.0], 2.5) == [[0, 1], [2], [3]]
    assert _pack_columns([], 2.5) == [[]]


def test_pack_columns_fills_a_page_exactly_before_starting_another() -> None:
    assert _pack_columns([1.0, 1.5, 1.0], 2.5) == [[0, 1], [2]]


def _decision_kpis_page(concentration: AnimalEmissionsConcentration) -> list[str]:
    pdf = _RecordingPdf()
    create_decision_kpis_page(pdf, concentration)  # ty: ignore[invalid-argument-type]
    return [t.text for t in pdf.pages[0]]


def test_decision_kpis_page_states_the_share_and_lists_the_products_in_order() -> None:
    concentration = AnimalEmissionsConcentration(
        top_products=("Ground Beef | 80/20", "Cheddar"),
        top_products_kg_co2e=1353.4,
        total_animal_kg_co2e=3490.0,
    )

    assert _decision_kpis_page(concentration) == [
        "Decision KPIs",
        "The top 2 animal products share of animal-product emissions was 38.8% amounting",
        "to 1,353 kg CO₂e.",
        "",
        "The top 2 animal products were:",
        "1. Ground Beef | 80/20",
        "2. Cheddar",
    ]


def test_decision_kpis_page_words_a_single_product_and_a_whole_share() -> None:
    concentration = AnimalEmissionsConcentration(
        top_products=("Ground Beef",), top_products_kg_co2e=50.0, total_animal_kg_co2e=50.0
    )

    assert _decision_kpis_page(concentration)[1:5] == [
        "The top 1 animal products share of animal-product emissions was 100% amounting",
        "to 50 kg CO₂e.",
        "",
        "The top 1 animal product was:",
    ]


def test_decision_kpis_page_wraps_a_long_product_name_without_losing_words() -> None:
    product = "Ground Beef | " + "very long description " * 6
    concentration = AnimalEmissionsConcentration(
        top_products=(product.strip(), "Cheddar"),
        top_products_kg_co2e=10.0,
        total_animal_kg_co2e=20.0,
    )

    lines = _decision_kpis_page(concentration)[5:]

    assert lines[0].startswith("1. Ground Beef | very long")
    assert " ".join(line.strip() for line in lines[:-1]) == "1. " + product.strip()
    assert lines[-1] == "2. Cheddar"


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


def test_substitution_scenarios_page_wraps_a_long_scenario_inside_its_cell() -> None:
    scenarios = pd.DataFrame(
        {
            "scenario": ["50% ruminant-to-legume swap with a long name", "10% swap"],
            "replaced_weight_kg": [10.0, 2.0],
            "projected_emissions_kg_co2e": [800.0, 900.0],
            "avoidable_kg_co2e": [100.0, 10.0],
            "institution_emissions_avoided_pct": [11.1, 1.1],
        }
    )
    pdf = _RecordingTablePdf()

    create_substitution_scenarios_page(pdf, scenarios)  # ty: ignore[invalid-argument-type]

    assert pdf.headings == ["Substitution Scenarios"]
    assert pdf.scenario_cells == ["50% ruminant-to-legume\nswap with a long name", "10% swap"]


# ----------------------------------------------------------------------
# Tests for _executive_narrative
# ----------------------------------------------------------------------


def test_executive_narrative_summarises_the_report() -> None:
    narrative = _executive_narrative(_report(), "Acme", "pass")

    assert asdict(narrative) == {
        "client": "Acme",
        "period": "Jan 2024 – Feb 2024",
        "total_food_kg": 60.0,
        "total_co2e_kg": pytest.approx(970.5),
        "co2e_per_head": ("diner", pytest.approx(970.5 / 220)),
        "plant_pct": 63.3,
        "animal_pct": 36.7,
        "any_animal": True,
        "top_categories": (
            ("Beef and Buffalo Meat", pytest.approx(100 * 909.7 / 970.5)),
            ("Legumes", pytest.approx(100 * 60.8 / 970.5)),
        ),
        "quality_status": "pass",
    }


def test_executive_narrative_without_headcounts_has_no_co2e_per_head() -> None:
    assert _executive_narrative(_report(headcounts=None), "Acme", "pass").co2e_per_head is None


def test_executive_narrative_lists_only_the_top_three_categories() -> None:
    report = replace(
        _report(),
        emissions_summary=pd.DataFrame(
            {"category": ["a", "b", "c", "d", "e"], "total_kg_co2e": [1.0, 4.0, np.nan, 3.0, 2.0]}
        ),
    )

    narrative = _executive_narrative(report, "Acme", "pass")

    assert narrative.total_co2e_kg == 10.0
    assert narrative.top_categories == (("b", 40.0), ("d", 30.0), ("e", 20.0))


def test_executive_narrative_omits_categories_without_emissions() -> None:
    report = replace(
        _report(),
        emissions_summary=pd.DataFrame(
            {"category": ["a", "b", "c"], "total_kg_co2e": [3.0, 1.0, 0.0]}
        ),
    )

    narrative = _executive_narrative(report, "Acme", "pass")

    assert narrative.top_categories == (("a", 75.0), ("b", 25.0))


@pytest.mark.parametrize(
    ("kg", "expected"),
    [
        (1999.4, "1,999 kg"),
        (2000, "2.0 tonnes"),
        (2501, "2.5 tonnes"),
        (9949, "9.9 tonnes"),
        (9960, "10 tonnes"),
        (12_499, "12 tonnes"),
        (1_234_567, "1,235 tonnes"),
    ],
)
def test_format_co2e(kg: float, expected: str) -> None:
    assert _format_co2e(kg) == expected


def _narrative(**overrides: Any) -> ExecutiveNarrative:
    kwargs: dict[str, Any] = {
        "client": "Acme",
        "period": "Jan 2024 – Feb 2024",
        "total_food_kg": 1234.5,
        "total_co2e_kg": 2501.0,
        "co2e_per_head": Co2ePerHead("meal", 1.2345),
        "plant_pct": 63.3,
        "animal_pct": 36.7,
        "any_animal": True,
        "top_categories": (
            CategoryShare("Beef and Buffalo Meat", 60.2),
            CategoryShare("Cheese", 20.4),
            CategoryShare("Legumes", 9.6),
        ),
        "quality_status": "pass",
    }
    return ExecutiveNarrative(**(kwargs | overrides))


def test_narrative_paragraphs_describe_the_footprint() -> None:
    assert _narrative_paragraphs(_narrative()) == [
        "Over this period the kitchen purchased about 1,234 kg of categorised food. Producing "
        "that food released an estimated 2.5 tonnes of carbon dioxide equivalent (CO₂e), the "
        "standard measure for comparing the climate impact of different foods. That works out "
        "at roughly 1.23 kg of CO₂e per meal.",
        "The biggest contributors were Beef and Buffalo Meat (60% of the food footprint), "
        "Cheese (20%) and Legumes (10%).",
        "Plant-based items made up 63% of the categorised food by weight, and animal products "
        "37%. Animal products carry far higher emissions per kilogram, so a small number of "
        "categories drive most of the footprint. Modest, targeted menu changes in those areas "
        "deliver the largest reductions.",
        "The pages that follow show how the footprint breaks down by month, category and "
        "product. The methodology is explained at the back.",
    ]


def test_narrative_paragraphs_without_headcounts_say_the_figures_are_totals() -> None:
    assert _narrative_paragraphs(_narrative(co2e_per_head=None))[0] == (
        "Over this period the kitchen purchased about 1,234 kg of categorised food. Producing "
        "that food released an estimated 2.5 tonnes of carbon dioxide equivalent (CO₂e), the "
        "standard measure for comparing the climate impact of different foods. No diner or meal "
        "counts were provided, so these figures are totals. Sites differ in size, so they can't "
        "be compared directly with other sites."
    )


def test_narrative_paragraphs_caveat_the_quality() -> None:
    paragraphs = _narrative_paragraphs(
        _narrative(
            plant_pct=100.0,
            animal_pct=0.0,
            any_animal=False,
            top_categories=(CategoryShare("Legumes", 70.0), CategoryShare("Cheese", 30.0)),
            quality_status="warning",
        )
    )

    assert paragraphs[1:] == [
        "The biggest contributors were Legumes (70%) and Cheese (30%).",
        "All of the categorised food was plant-based.",
        "Some data-quality notes apply to this analysis; they are listed in plain language on "
        "the next page.",
        "The pages that follow show how the footprint breaks down by month, category and "
        "product. The methodology is explained at the back.",
    ]


@pytest.mark.parametrize(
    ("plant_pct", "animal_pct"),
    [(100.0, 0.0), (99.6, 0.4)],
    ids=["0.04% animal, rounded to 0.0", "0.4% animal"],
)
def test_narrative_paragraphs_never_round_a_nonzero_share_to_zero_or_all(
    plant_pct: float, animal_pct: float
) -> None:
    paragraph = _narrative_paragraphs(_narrative(plant_pct=plant_pct, animal_pct=animal_pct))[2]

    assert paragraph.startswith(
        "Plant-based items made up over 99% of the categorised food by weight, and animal "
        "products under 1%."
    )


@pytest.mark.parametrize("count", [0, 4])
def test_executive_narrative_rejects_a_count_of_top_categories_it_cannot_word(count: int) -> None:
    with pytest.raises(ValueError, match=f"got {count}"):
        _narrative(top_categories=(CategoryShare("Legumes", 10.0),) * count)


def test_narrative_paragraphs_skip_the_animal_sentence_on_plant_only_food() -> None:
    narrative = _executive_narrative(_report(animal_product=None), "Acme", "pass")

    assert _narrative_paragraphs(narrative)[1:] == [
        "The biggest contributors were Legumes (100%).",
        "All of the categorised food was plant-based.",
        "The pages that follow show how the footprint breaks down by month, category and "
        "product. The methodology is explained at the back.",
    ]
