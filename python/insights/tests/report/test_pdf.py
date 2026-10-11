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
    ExecutiveNarrative,
    _executive_narrative,
    _format_animal_emissions_intensity_for_pdf,
    _format_category_template_for_pdf,
    _format_co2e,
    _format_substitution_scenarios_for_pdf,
    _narrative_paragraphs,
    _pack_columns,
    _quality_to_lines,
    _wrap_text_lines,
    _wrap_to_width,
    create_category_template_pages,
    create_decision_kpis_page,
    create_title_page,
    write_report_pdf,
)
from gbd_foodservice_insights.report.quality import Finding, make_finding
from gbd_foodservice_insights.report.schema import DiagnosticStatus, DinerOrMeal
from matplotlib.figure import Figure
from matplotlib.font_manager import FontProperties
from matplotlib.textpath import text_to_path
from PyPDF2 import PdfReader

JAN, FEB = pd.period_range("2024-01", periods=2, freq="M")


def test_wrap_text_lines_preserves_bullets_and_wraps_long_lines() -> None:
    wrapped = _wrap_text_lines(
        [
            "  • Warning: Found 1716 rows that are exact duplicates across the key report "
            "fields and the text needs to wrap onto another visual row to avoid collisions.",
            "      - Eggs Medium Av51g on 2024-07-01 00:00:00 appears 149 times and should "
            "also wrap cleanly.",
        ],
        width=60,
    )

    assert len(wrapped) > 2
    assert wrapped[0].startswith("  • ")
    assert wrapped[1].startswith("    ")
    assert any(line.startswith("      - ") for line in wrapped)


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
        stage="test", category="test", status=status, message=message, sample_values=sample_values
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
        "diner_meal_mapping": {JAN: 100, FEB: 120},
        "mode": "procurement",
        "region": "us",
        "diner_or_meal": "diner",
        "top_n_drivers": 5,
    }
    product, category = animal_product or ("Chickpeas", "Legumes")
    metric = "servings total" if overrides.get("mode") == "serving" else "kilos_total"
    rows = pd.DataFrame(
        {
            "date": pd.to_datetime(["2024-01-15", "2024-01-20", "2024-02-15", "2024-02-20"]),
            "product": [product, "Lentils", product, "Lentils"],
            "category": [category, "Legumes", category, "Legumes"],
            metric: [10.0, 20.0, 12.0, 18.0],
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
        baseline_pilot="pilot",
        show_quality_successes=False,
    )


def _title_page(client: str) -> list[_PageText]:
    pdf = _RecordingPdf()
    create_title_page(pdf, client, "baseline", "procurement")  # ty: ignore[invalid-argument-type]
    return pdf.pages[0]


def test_title_page_shows_the_client_name_as_typed() -> None:
    assert [t.text for t in _title_page("McDonald's")][:3] == [
        "Food Report",
        "McDonald's",
        "Baseline | Procurement",
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


# ----------------------------------------------------------------------
# Tests for write_report_pdf
# ----------------------------------------------------------------------


def test_write_report_pdf_orders_the_procurement_pages(recording_pdf: _RecordingPdf) -> None:
    fig = plt.figure()

    _write(_report(), charts=ReportCharts(figures=[("caption", fig)]))
    plt.close(fig)

    assert _page_titles(recording_pdf) == [
        "Food Report",
        "Executive Summary",
        "How to Read This Report",
        "",
        "Category Template",
        "Animal Emissions Intensity",
        "Decision KPIs",
        "Substitution Scenarios",
        "About This Report",
        "Data Completeness & Quality",
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
    assert titles[titles.index("Category Template") + 1 : -2] == procurement_pages


def test_write_report_pdf_summarises_a_serving_report_as_key_values(
    recording_pdf: _RecordingPdf,
) -> None:
    report = _report(mode="serving")

    _write(report)

    assert _page_titles(recording_pdf) == [
        "Food Report",
        "Executive Summary",
        "How to Read This Report",
        "Category Template",
        "About This Report",
        "Data Completeness & Quality",
    ]
    assert [t.text for t in recording_pdf.pages[1]] == [
        "Executive Summary",
        *(f"{label}:  {value}" for label, value in report.summary_stats.items()),
        "Data Quality Status:  PASS",
    ]


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
    assert (
        titles[titles.index("Data Completeness & Quality") + 1 :]
        == ["Data Completeness & Quality (cont.)"] * 3
    )


def test_write_report_pdf_does_not_render_plot_captions(tmp_path: Path) -> None:
    path = tmp_path / "report.pdf"
    fig = plt.figure()

    _write(_report(), path, ReportCharts(figures=[("This caption should not appear.", fig)]))
    plt.close(fig)

    page_text = "".join(page.extract_text() or "" for page in PdfReader(str(path)).pages)
    assert "Thiscaptionshouldnotappear" not in "".join(page_text.split())


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
        _write(_report(), tmp_path / "report.pdf", ReportCharts(figures=[("caption", fig)]))

    assert set(plt.get_fignums()) == before | {fig.number}
    plt.close(fig)


def test_write_report_pdf_leaves_the_callers_plots_open(tmp_path: Path) -> None:
    before = set(plt.get_fignums())
    fig = plt.figure()

    _write(_report(), tmp_path / "report.pdf", ReportCharts(figures=[("caption", fig)]))

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


@pytest.mark.parametrize("diner_or_meal", ["diner", "meal"])
def test_text_pages_normalise_by_the_counts_basis(
    recording_pdf: _RecordingPdf, diner_or_meal: DinerOrMeal
) -> None:
    _write(_report(diner_or_meal=diner_or_meal))

    words = [
        word
        for page in recording_pdf.pages
        if page and page[0].text in {"How to Read This Report", "About This Report"}
        for t in page
        for word in t.text.split()
    ]
    text = " ".join(words)
    assert f"how many {diner_or_meal}s were served each month" in text
    assert f"the number of {diner_or_meal}s served" in text
    assert "people" not in text


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
    assert ("Extrafinding" in pages[-1]) is caveat_shown
    assert ("Allautomateddatacheckspassed" in pages[-1]) is not caveat_shown


def test_quality_lines_explain_an_invalid_status() -> None:
    assert _quality_to_lines(
        "invalid",
        {"by_status": {"success": 1, "error": 1}},
        [
            _finding("success", "All required columns present."),
            _finding("error", "Found 2 negative values in 'kilos_total'."),
        ],
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
    assert _quality_to_lines(
        "warning",
        {"by_status": {"success": 1, "info": 1, "warning": 1}},
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


class _RecordingTablePdf:
    """Stands in for ``PdfPages``, keeping each table page's heading, column labels, and the
    cells whose text runs past the cell's right edge."""

    def __init__(self) -> None:
        self.headings: list[str] = []
        self.columns: list[list[str]] = []
        self.overflowing: list[str] = []

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


# ----------------------------------------------------------------------
# Tests for _executive_narrative
# ----------------------------------------------------------------------


def test_executive_narrative_summarises_the_report() -> None:
    narrative = _executive_narrative(_report(), "Acme", "pass")

    assert narrative is not None
    assert asdict(narrative) == {
        "client": "Acme",
        "period": "Jan 2024 – Feb 2024",
        "total_food_kg": 60.0,
        "total_co2e_kg": pytest.approx(970.5),
        "co2e_kg_per_diner_or_meal": pytest.approx(970.5 / 220),
        "diner_or_meal": "diner",
        "plant_and_animal_pct": (63.3, 36.7),
        "top_categories": (
            ("Beef and Buffalo Meat", pytest.approx(100 * 909.7 / 970.5)),
            ("Legumes", pytest.approx(100 * 60.8 / 970.5)),
        ),
        "quality_status": "pass",
    }


def test_executive_narrative_lists_only_the_top_three_categories() -> None:
    report = replace(
        _report(),
        emissions_summary=pd.DataFrame(
            {"category": ["a", "b", "c", "d", "e"], "total_kg_co2e": [1.0, 4.0, np.nan, 3.0, 2.0]}
        ),
    )

    narrative = _executive_narrative(report, "Acme", "pass")

    assert narrative is not None
    assert narrative.total_co2e_kg == 10.0
    assert narrative.top_categories == (("b", 40.0), ("d", 30.0), ("e", 20.0))


def test_executive_narrative_leaves_per_unit_and_split_blank_when_unknown() -> None:
    report = replace(_report(), diner_meals_in_data=0.0, plant_animal_split=None)

    narrative = _executive_narrative(report, "Acme", "pass")

    assert narrative is not None
    assert (narrative.co2e_kg_per_diner_or_meal, narrative.plant_and_animal_pct) == (None, None)


@pytest.mark.parametrize(
    "emissions_summary",
    [
        None,
        pd.DataFrame({"category": ["Legumes"]}),
        pd.DataFrame({"category": ["Legumes"], "total_kg_co2e": [0.0]}),
        pd.DataFrame({"category": ["Legumes"], "total_kg_co2e": [np.nan]}),
    ],
    ids=["no-summary", "no-total-column", "zero-total", "all-missing"],
)
def test_executive_narrative_is_omitted_without_positive_emissions(
    emissions_summary: pd.DataFrame | None,
) -> None:
    report = replace(_report(), emissions_summary=emissions_summary)

    assert _executive_narrative(report, "Acme", "pass") is None


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
        "co2e_kg_per_diner_or_meal": 1.2345,
        "diner_or_meal": "meal",
        "plant_and_animal_pct": (63.3, 36.7),
        "top_categories": (("Beef and Buffalo Meat", 60.2), ("Cheese", 20.4), ("Legumes", 9.6)),
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


def test_narrative_paragraphs_skip_what_is_unknown_and_caveat_the_quality() -> None:
    paragraphs = _narrative_paragraphs(
        _narrative(
            co2e_kg_per_diner_or_meal=None,
            plant_and_animal_pct=None,
            top_categories=(("Legumes", 70.0), ("Cheese", 30.0)),
            quality_status="warning",
        )
    )

    assert paragraphs[0].endswith("the climate impact of different foods.")
    assert paragraphs[1:] == [
        "The biggest contributors were Legumes (70%) and Cheese (30%).",
        "Some data-quality notes apply to this analysis; they are listed in plain language at "
        "the back of this report.",
        "The pages that follow show how the footprint breaks down by month, category and "
        "product. The methodology is explained at the back.",
    ]


def test_narrative_paragraphs_skip_the_animal_sentence_on_plant_only_food() -> None:
    narrative = _executive_narrative(_report(animal_product=None), "Acme", "pass")
    assert narrative is not None

    paragraphs = _narrative_paragraphs(narrative)

    assert "All of the categorised food was plant-based." in paragraphs
    assert not any("nimal" in paragraph for paragraph in paragraphs)


def test_narrative_paragraphs_spell_co2e_with_the_subscript_throughout() -> None:
    text = " ".join(_narrative_paragraphs(_narrative()))

    assert "CO₂e" in text
    assert "CO2e" not in text
