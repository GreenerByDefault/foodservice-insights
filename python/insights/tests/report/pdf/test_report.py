from contextlib import nullcontext
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights.plotting_utils import BODY_FONT, TITLE_FONT
from gbd_foodservice_insights.report.aggregation import AnimalEmissionsConcentration
from gbd_foodservice_insights.report.food_report import FoodReport, ReportCharts, build_food_report
from gbd_foodservice_insights.report.pdf import report as report_module
from gbd_foodservice_insights.report.pdf.report import write_report_pdf
from gbd_foodservice_insights.report.pdf.summary import (
    CategoryShare,
    Co2ePerHead,
    ExecutiveNarrative,
    PageRefs,
    _format_co2e,
    _narrative_paragraphs,
    create_executive_summary_page,
    executive_narrative,
)
from gbd_foodservice_insights.report.pdf.text_pages import (
    _wrap_text_lines,
    create_decision_kpis_page,
    create_text_page,
    create_title_page,
)
from gbd_foodservice_insights.report.quality import Finding, make_finding
from gbd_foodservice_insights.report.schema import DiagnosticStatus, DinerOrMeal, Headcounts
from matplotlib.figure import Figure
from matplotlib.font_manager import FontProperties
from matplotlib.textpath import text_to_path
from pypdf import PdfReader

JAN, FEB = pd.period_range("2024-01", periods=2, freq="M")


def _fits(line: str, max_width_in: float, fontsize: float) -> bool:
    width_pt, _, _ = text_to_path.get_text_width_height_descent(
        line, FontProperties(family=BODY_FONT, size=fontsize), ismath=False
    )
    return width_pt <= max_width_in * 72


@pytest.mark.parametrize(("marker", "hang"), [("  • ", "    "), ("  12. ", "      ")])
def test_wrap_text_lines_hangs_wrapped_text_under_its_marker(marker: str, hang: str) -> None:
    text = "Found 1716 rows that are exact duplicates across the key report fields " * 3

    wrapped = _wrap_text_lines([marker + text], max_width_in=3.0, fontsize=11)

    assert len(wrapped) > 2
    assert wrapped[0].startswith(marker + "Found")
    assert all(line.startswith(hang) and line[len(hang)] != " " for line in wrapped[1:])
    assert " ".join(line.strip() for line in wrapped) == (marker + text).strip()
    assert all(_fits(line, 3.0, 11) for line in wrapped)


def test_wrap_text_lines_keeps_indentation_and_collapses_blank_lines() -> None:
    assert _wrap_text_lines(["  indented", "", "   ", "x"], 6.5, 11) == [
        "  indented",
        "",
        "",
        "x",
    ]
    assert _wrap_text_lines([], 6.5, 11) == [""]


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
        self.footers: list[list[str]] = []

    def savefig(self, fig: Figure) -> None:
        self.footers.append([t.get_text() for t in fig.texts])
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
    monkeypatch.setattr(report_module, "PdfPages", lambda _path: nullcontext(pdf))
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
    create_title_page(pdf, client, "Procurement")
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
    name_lines, subtitle = texts[1:-3], texts[-3]
    prop = FontProperties(family=TITLE_FONT, size=20)

    assert len(name_lines) > 1
    assert " ".join(t.text for t in name_lines) == client
    for line in name_lines:
        width_pt, _, _ = text_to_path.get_text_width_height_descent(line.text, prop, ismath=False)
        assert width_pt / 72 <= 6.5
    assert name_lines[-1].y > subtitle.y


def test_procurement_title_page_spans_the_input_dates(recording_pdf: _RecordingPdf) -> None:
    _write(_report())

    assert [t.text for t in recording_pdf.pages[0]][2] == "Procurement | Jan 2024 – Feb 2024"


def test_title_page_replaces_underscores_in_the_client_name() -> None:
    assert [t.text for t in _title_page("acme_corp")][1] == "acme corp"


def _text_page_titles(lines: list[str], bold_lines: set[str] | None = None) -> list[str]:
    pdf = _RecordingPdf()
    create_text_page(pdf, "Title", lines, bold_lines=bold_lines)
    return _page_titles(pdf)


@pytest.mark.parametrize(
    ("line_count", "titles"),
    [
        (0, ["Title"]),
        (32, ["Title"]),
        (33, ["Title", "Title (cont.)"]),
        (64, ["Title", "Title (cont.)"]),
        (65, ["Title", "Title (cont.)", "Title (cont.)"]),
    ],
)
def test_text_page_fits_32_lines_per_page(line_count: int, titles: list[str]) -> None:
    assert _text_page_titles([f"line {i}" for i in range(line_count)]) == titles


def test_text_page_bolds_lines_compared_after_stripping() -> None:
    pdf = _RecordingPdf()

    create_text_page(
        pdf,
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
    create_executive_summary_page(pdf, narrative, PageRefs(quality=3, methodology=12))
    return pdf.pages[0]


def test_executive_summary_page_leads_with_the_headline_and_fits_the_page() -> None:
    narrative = _narrative(client="The University of Somewhere Hospitality and Conference Services")

    texts = _summary_page(narrative)

    assert [t.text for t in texts[:2]] == ["Executive Summary", "2.5 metric tons CO₂e"]
    assert texts[2].text.startswith("the greenhouse gas footprint of food purchased by The")
    assert " ".join(t.text for t in texts).endswith("The methodology is on page 12.")
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
        "About This Report (cont.)",
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

    monkeypatch.setattr(report_module, "create_executive_summary_page", _boom)

    with pytest.raises(RuntimeError, match="boom"):
        _write(_report(), tmp_path / "report.pdf", ReportCharts(figures=[fig]))

    assert set(plt.get_fignums()) == before | {fig.number}
    plt.close(fig)


def test_write_report_pdf_leaves_the_callers_plots_open(tmp_path: Path) -> None:
    before = set(plt.get_fignums())
    fig = plt.figure()

    _write(_report(), tmp_path / "report.pdf", ReportCharts(figures=[fig]))

    assert set(plt.get_fignums()) == before | {fig.number}
    assert fig.texts == []
    plt.close(fig)


def test_write_report_pdf_numbers_every_page_but_the_title(recording_pdf: _RecordingPdf) -> None:
    fig = plt.figure()

    _write(_report(), charts=ReportCharts(figures=[fig]))
    plt.close(fig)

    assert recording_pdf.footers == [[], *([str(n)] for n in range(2, 12))]


def test_write_report_pdf_points_the_summary_at_the_quality_and_methodology_pages(
    recording_pdf: _RecordingPdf,
) -> None:
    long_warning = _finding("warning", "Something to note. " * 40)

    _write(replace(_report(), findings=(long_warning,) * 12))

    titles = _page_titles(recording_pdf)
    summary = " ".join(t.text for t in recording_pdf.pages[1])
    assert titles[2] == "Data Completeness & Quality"
    assert "they are listed on page 3." in summary
    assert summary.endswith(f"The methodology is on page {titles.index('About This Report') + 1}.")
    assert "Data Completeness & Quality (cont.)" in titles


def test_about_page_bolds_every_heading(recording_pdf: _RecordingPdf) -> None:
    _write(_report())

    about_pages = [
        page for page in recording_pdf.pages if page and page[0].text.startswith("About This")
    ]
    assert [t.text for page in about_pages for t in page[1:] if t.bold] == [
        "What is procurement data?",
        "How are carbon figures calculated?",
        "How should I interpret the monthly figures?",
        "How should I use this report?",
        "References",
    ]


def _how_to_read_and_about_text(pdf: _RecordingPdf) -> str:
    """Both pages' words, joined by single spaces, so a phrase matches across line breaks."""
    return " ".join(
        word
        for page in pdf.pages
        if page and page[0].text.startswith(("How to Read This Report", "About This Report"))
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
    assert "normalizing" not in text


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


def _decision_kpis_page(concentration: AnimalEmissionsConcentration) -> list[str]:
    pdf = _RecordingPdf()
    create_decision_kpis_page(pdf, concentration)
    return [t.text for t in pdf.pages[0]]


def test_decision_kpis_page_states_the_share_and_lists_the_products_in_order() -> None:
    concentration = AnimalEmissionsConcentration(
        top_products=("Ground Beef | 80/20", "Cheddar"),
        top_products_kg_co2e=1353.4,
        total_animal_kg_co2e=3490.0,
    )

    assert _decision_kpis_page(concentration) == [
        "Decision KPIs",
        "The 2 animal products with the highest emissions accounted for 38.8% of",
        "animal-product emissions (1,353 kg CO₂e):",
        "",
        "  1. Ground Beef | 80/20",
        "  2. Cheddar",
    ]


def test_decision_kpis_page_words_a_single_product_and_a_whole_share() -> None:
    concentration = AnimalEmissionsConcentration(
        top_products=("Ground Beef",), top_products_kg_co2e=50.0, total_animal_kg_co2e=50.0
    )

    assert _decision_kpis_page(concentration)[1:3] == [
        "The animal product with the highest emissions accounted for 100% of",
        "animal-product emissions (50 kg CO₂e):",
    ]


def test_decision_kpis_page_wraps_a_long_product_name_without_losing_words() -> None:
    product = "Ground Beef | " + "very long description " * 6
    concentration = AnimalEmissionsConcentration(
        top_products=(product.strip(), "Cheddar"),
        top_products_kg_co2e=10.0,
        total_animal_kg_co2e=20.0,
    )

    lines = _decision_kpis_page(concentration)[4:]

    assert lines[0].startswith("  1. Ground Beef | very long")
    assert " ".join(line.strip() for line in lines[:-1]) == "1. " + product.strip()
    assert lines[-1] == "  2. Cheddar"


# ----------------------------------------------------------------------
# Tests for _executive_narrative
# ----------------------------------------------------------------------


def test_executive_narrative_summarises_the_report() -> None:
    narrative = executive_narrative(_report(), "Acme", "pass")

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
    assert executive_narrative(_report(headcounts=None), "Acme", "pass").co2e_per_head is None


def test_executive_narrative_lists_only_the_top_three_categories() -> None:
    report = replace(
        _report(),
        emissions_summary=pd.DataFrame(
            {"category": ["a", "b", "c", "d", "e"], "total_kg_co2e": [1.0, 4.0, np.nan, 3.0, 2.0]}
        ),
    )

    narrative = executive_narrative(report, "Acme", "pass")

    assert narrative.total_co2e_kg == 10.0
    assert narrative.top_categories == (("b", 40.0), ("d", 30.0), ("e", 20.0))


def test_executive_narrative_omits_categories_without_emissions() -> None:
    report = replace(
        _report(),
        emissions_summary=pd.DataFrame(
            {"category": ["a", "b", "c"], "total_kg_co2e": [3.0, 1.0, 0.0]}
        ),
    )

    narrative = executive_narrative(report, "Acme", "pass")

    assert narrative.top_categories == (("a", 75.0), ("b", 25.0))


@pytest.mark.parametrize(
    ("kg", "expected"),
    [
        (1999.4, "1,999 kg"),
        (2000, "2.0 metric tons"),
        (2501, "2.5 metric tons"),
        (9949, "9.9 metric tons"),
        (9960, "10 metric tons"),
        (12_499, "12 metric tons"),
        (1_234_567, "1,235 metric tons"),
    ],
)
def test_format_co2e(kg: float, expected: str) -> None:
    assert _format_co2e(kg) == expected


_PAGE_REFS = PageRefs(quality=3, methodology=12)


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
    assert _narrative_paragraphs(_narrative(), _PAGE_REFS) == [
        "Over this period the kitchen purchased about 1,234 kg of categorized food. Producing "
        "that food, up to the farm gate, released an estimated 2.5 metric tons of carbon dioxide "
        "equivalent (CO₂e), the standard unit for comparing the climate impact of different "
        "foods. That works out "
        "at roughly 1.23 kg of CO₂e per meal.",
        "The biggest contributors were Beef and Buffalo Meat (60% of the food footprint), "
        "Cheese (20%) and Legumes (10%).",
        "Within the categories this report tracks (mainly animal proteins, dairy, and their "
        "plant-based alternatives), plant-based items made up 63% of food by weight and animal "
        "products 37%. Fruit, vegetables, and other foods outside these categories are not "
        "included. Animal products carry far higher emissions per kilogram, so a small number of "
        "categories drive most of the footprint. Modest, targeted menu changes in those areas "
        "deliver the largest reductions.",
        "The pages that follow show how the footprint breaks down by month, category and "
        "product. The methodology is on page 12.",
    ]


def test_narrative_paragraphs_without_headcounts_say_the_figures_are_totals() -> None:
    assert _narrative_paragraphs(_narrative(co2e_per_head=None), _PAGE_REFS)[0] == (
        "Over this period the kitchen purchased about 1,234 kg of categorized food. Producing "
        "that food, up to the farm gate, released an estimated 2.5 metric tons of carbon dioxide "
        "equivalent (CO₂e), the standard unit for comparing the climate impact of different "
        "foods. No diner or meal "
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
        ),
        _PAGE_REFS,
    )

    assert paragraphs[1:] == [
        "The biggest contributors were Legumes (70%) and Cheese (30%).",
        "All of the categorized food was plant-based.",
        "Some data-quality notes apply to this analysis; they are listed on page 3.",
        "The pages that follow show how the footprint breaks down by month, category and "
        "product. The methodology is on page 12.",
    ]


@pytest.mark.parametrize(
    ("plant_pct", "animal_pct"),
    [(100.0, 0.0), (99.6, 0.4)],
    ids=["0.04% animal, rounded to 0.0", "0.4% animal"],
)
def test_narrative_paragraphs_never_round_a_nonzero_share_to_zero_or_all(
    plant_pct: float, animal_pct: float
) -> None:
    paragraph = _narrative_paragraphs(
        _narrative(plant_pct=plant_pct, animal_pct=animal_pct), _PAGE_REFS
    )[2]

    assert "plant-based items made up over 99% of food by weight and animal products under 1%." in (
        paragraph
    )


@pytest.mark.parametrize("count", [0, 4])
def test_executive_narrative_rejects_a_count_of_top_categories_it_cannot_word(count: int) -> None:
    with pytest.raises(ValueError, match=f"got {count}"):
        _narrative(top_categories=(CategoryShare("Legumes", 10.0),) * count)


def test_narrative_paragraphs_skip_the_animal_sentence_on_plant_only_food() -> None:
    narrative = executive_narrative(_report(animal_product=None), "Acme", "pass")

    assert _narrative_paragraphs(narrative, _PAGE_REFS)[1:] == [
        "The biggest contributors were Legumes (100%).",
        "All of the categorized food was plant-based.",
        "The pages that follow show how the footprint breaks down by month, category and "
        "product. The methodology is on page 12.",
    ]
