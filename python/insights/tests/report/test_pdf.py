from collections.abc import Callable
from contextlib import nullcontext
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights.report import pdf as pdf_module
from gbd_foodservice_insights.report.food_report import FoodReport, ReportCharts, build_food_report
from gbd_foodservice_insights.report.pdf import (
    _executive_narrative,
    _format_animal_emissions_intensity_for_pdf,
    _format_category_template_for_pdf,
    _format_co2e,
    _format_decision_kpis_for_pdf,
    _format_substitution_scenarios_for_pdf,
    _narrative_paragraphs,
    _quality_to_lines,
    _wrap_text_lines,
    _wrap_to_width,
    build_pdf_report,
    create_title_page,
    write_report_pdf,
)
from gbd_foodservice_insights.report.quality import summarize_findings
from gbd_foodservice_insights.report.schema import DinerOrMeal
from matplotlib.figure import Figure
from matplotlib.font_manager import FontProperties
from matplotlib.textpath import text_to_path
from PyPDF2 import PdfReader


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


def test_build_pdf_report_splits_long_quality_pages(tmp_path: Path) -> None:
    output_path = tmp_path / "quality-report.pdf"
    long_findings = [
        {
            "status": "warning",
            "message": (
                "Found duplicate line items across the report fields. This explanatory "
                "sentence is intentionally long so the rendered PDF needs multiple "
                "wrapped rows for each finding."
            ),
            "sample_values": [
                "Eggs Medium Av51g on 2024-07-01 00:00:00 appears 149 times and remains "
                "long enough to wrap.",
            ]
            * 5,
        }
        for _ in range(12)
    ]

    build_pdf_report(
        output_path=str(output_path),
        title_info={
            "client": "test client",
            "baseline_pilot": "baseline",
            "procurement_serving": "procurement",
        },
        plots=[],
        tables={},
        summary_stats={"Rows": 100},
        quality_status="warning",
        quality_summary={"by_status": {"warning": len(long_findings)}},
        missing_data_findings=long_findings,
    )

    reader = PdfReader(str(output_path))

    assert len(reader.pages) >= 4


def test_build_pdf_report_does_not_render_plot_captions(tmp_path: Path) -> None:
    output_path = tmp_path / "captionless-report.pdf"
    fig = plt.figure()

    build_pdf_report(
        output_path=str(output_path),
        title_info={
            "client": "test client",
            "baseline_pilot": "baseline",
            "procurement_serving": "procurement",
        },
        plots=[("This chart caption should not appear in the PDF output.", fig)],
        tables={},
        summary_stats={"Rows": 100},
        quality_status="pass",
        quality_summary={"by_status": {"success": 1}},
        missing_data_findings=[],
    )

    reader = PdfReader(str(output_path))
    page_text = "\n".join(page.extract_text() or "" for page in reader.pages)

    assert "This chart caption should not appear in the PDF output." not in page_text
    plt.close(fig)


def test_build_pdf_report_closes_its_own_figures_when_a_page_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    output_path = tmp_path / "error-report.pdf"
    before = set(plt.get_fignums())
    fig = plt.figure()

    def _boom(*_args: object, **_kwargs: object) -> None:
        plt.figure()
        raise RuntimeError("boom")

    monkeypatch.setattr(pdf_module, "create_executive_summary_page", _boom)

    with pytest.raises(RuntimeError, match="boom"):
        build_pdf_report(
            output_path=str(output_path),
            title_info={
                "client": "test client",
                "baseline_pilot": "baseline",
                "procurement_serving": "procurement",
            },
            plots=[("caption", fig)],
            tables={},
            summary_stats={"Rows": 100},
            quality_status="pass",
            quality_summary={"by_status": {"success": 1}},
            missing_data_findings=[],
        )

    assert set(plt.get_fignums()) == before | {fig.number}
    plt.close(fig)


def test_build_pdf_report_leaves_the_callers_plots_open(tmp_path: Path) -> None:
    before = set(plt.get_fignums())
    fig = plt.figure()

    build_pdf_report(
        output_path=str(tmp_path / "report.pdf"),
        title_info={
            "client": "test client",
            "baseline_pilot": "baseline",
            "procurement_serving": "procurement",
        },
        plots=[("caption", fig)],
        tables={},
        summary_stats={"Rows": 100},
    )

    assert set(plt.get_fignums()) == before | {fig.number}
    plt.close(fig)


def test_build_pdf_report_places_quality_section_at_end(tmp_path: Path) -> None:
    output_path = tmp_path / "quality-last-report.pdf"

    build_pdf_report(
        output_path=str(output_path),
        title_info={
            "client": "test client",
            "baseline_pilot": "baseline",
            "procurement_serving": "procurement",
        },
        plots=[],
        tables={},
        summary_stats={"Rows": 100},
        quality_status="warning",
        quality_summary={"by_status": {"warning": 1}},
        missing_data_findings=[{"status": "warning", "message": "Example quality finding"}],
    )

    reader = PdfReader(str(output_path))
    page_titles = [page.extract_text() or "" for page in reader.pages]

    assert "About This Report" in page_titles[-2]
    assert "Data Completeness & Quality" in page_titles[-1]


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


def test_about_page_bolds_every_heading(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pdf = _RecordingPdf()
    monkeypatch.setattr(pdf_module, "PdfPages", lambda _path: nullcontext(pdf))

    build_pdf_report(
        output_path=str(tmp_path / "report.pdf"),
        title_info={"client": "Acme", "baseline_pilot": "baseline", "procurement_serving": ""},
        plots=[],
        tables={},
        summary_stats={"Rows": 100},
    )

    (about,) = [page for page in pdf.pages if page and page[0].text == "About This Report"]
    assert [t.text for t in about[1:] if t.bold] == [
        "What is procurement data?",
        "How are carbon figures calculated?",
        "How should I interpret the monthly figures?",
        "How should I use this report?",
    ]


@pytest.mark.parametrize("diner_or_meal", ["diner", "meal"])
def test_text_pages_normalise_by_the_counts_basis(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, diner_or_meal: DinerOrMeal
) -> None:
    pdf = _RecordingPdf()
    monkeypatch.setattr(pdf_module, "PdfPages", lambda _path: nullcontext(pdf))

    build_pdf_report(
        output_path=str(tmp_path / "report.pdf"),
        title_info={"client": "Acme", "baseline_pilot": "baseline", "procurement_serving": ""},
        plots=[],
        tables={},
        summary_stats={"Rows": 100},
        diner_or_meal=diner_or_meal,
    )

    words = [
        word
        for page in pdf.pages
        if page and page[0].text in {"How to Read This Report", "About This Report"}
        for t in page
        for word in t.text.split()
    ]
    text = " ".join(words)
    assert f"how many {diner_or_meal}s were served each month" in text
    assert f"the number of {diner_or_meal}s served" in text
    assert "people" not in text


def test_quality_lines_explain_an_invalid_status() -> None:
    assert _quality_to_lines(
        "invalid",
        {"by_status": {"success": 1, "error": 1}},
        [
            {"status": "success", "message": "All required columns present."},
            {"status": "error", "message": "Found 2 negative values in 'kilos_total'."},
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
            {"status": "success", "message": "All required columns present."},
            {"status": "info", "message": "GBD categories absent from data: ['Butter']"},
            {"status": "warning", "message": "Found 1 month with a large swing."},
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


def test_build_pdf_report_renders_table_index_as_a_regular_column(tmp_path: Path) -> None:
    output_path = tmp_path / "table-report.pdf"

    build_pdf_report(
        output_path=str(output_path),
        title_info={
            "client": "test client",
            "baseline_pilot": "baseline",
            "procurement_serving": "procurement",
        },
        plots=[],
        tables={
            "Category Template": pd.DataFrame(
                {"2024-01": [1714.378], "total": [5577.653]},
                index=pd.Index(["Beef and Buffalo Meat"], name="category"),
            )
        },
        summary_stats={"Rows": 100},
        quality_status="pass",
        quality_summary={"by_status": {"success": 1}},
        missing_data_findings=[],
    )

    reader = PdfReader(str(output_path))
    page_text = "\n".join(page.extract_text() or "" for page in reader.pages)
    # PDF text extraction can insert spurious spaces inside words because glyph
    # spacing differs across platforms (some words come back split on Linux CI
    # runners), so assert against the text with all whitespace removed.
    collapsed_text = "".join(page_text.split())

    assert "CategoryTemplate" in collapsed_text
    assert "category" in collapsed_text.lower()
    assert "BeefandBuffaloMeat" in collapsed_text


def test_build_pdf_report_handles_long_decision_kpi_text(tmp_path: Path) -> None:
    output_path = tmp_path / "decision-kpi-report.pdf"

    build_pdf_report(
        output_path=str(output_path),
        title_info={
            "client": "test client",
            "baseline_pilot": "baseline",
            "procurement_serving": "procurement",
        },
        plots=[],
        tables={
            "Decision KPIs": pd.DataFrame(
                {
                    "Focus": ["Top 5 animal products share of animal-product emissions"],
                    "Share of Animal Emissions (%)": [38.8],
                    "Top Animal Products": [
                        "BEEF PATTY, GROUND 80/20, OZ BALL RAW BF SMASH, MEATLOAF, BEEF UNSLICED"
                    ],
                    "Top Products Kg CO2e": [168372],
                    "Total Animal Kg CO2e": [433448],
                }
            )
        },
        summary_stats={"Rows": 100},
        quality_status="pass",
        quality_summary={"by_status": {"success": 1}},
        missing_data_findings=[],
    )

    reader = PdfReader(str(output_path))
    assert output_path.exists()
    assert len(reader.pages) >= 4


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
                "CO2e Per Kg Food": [41.35],
                "Kg CO2e": pd.array([910], dtype="Int64"),
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


def test_format_decision_kpis_drops_internal_columns_and_rounds() -> None:
    table = pd.DataFrame(
        {
            "KPI": ["Top 1 animal products share of animal-product emissions"],
            "Value": [38.84],
            "Unit": ["%"],
            "Denominator": ["Animal-product emissions only"],
            "Top products": ["Ground Beef"],
            "Top product emissions (kg CO2e)": ["n/a"],
            "Total animal emissions (kg CO2e)": [909.7],
        }
    )

    pd.testing.assert_frame_equal(
        _format_decision_kpis_for_pdf(table),
        pd.DataFrame(
            {
                "Focus": ["Top 1 animal products share of animal-product emissions"],
                "Share of Animal Emissions (%)": [38.8],
                "Top Animal Products": ["Ground Beef"],
                # A value that is not a number renders blank rather than failing the report.
                "Top Products Kg CO2e": pd.array([pd.NA], dtype="Int64"),
                "Total Animal Kg CO2e": pd.array([910], dtype="Int64"),
            }
        ),
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
                "Projected Kg CO2e": pd.array([822], dtype="Int64"),
                "Avoidable Kg CO2e": pd.array([87], dtype="Int64"),
                "Institution Emissions Averted (%)": [9.01],
            }
        ),
    )


@pytest.mark.parametrize(
    "format_table",
    [
        _format_animal_emissions_intensity_for_pdf,
        _format_category_template_for_pdf,
        _format_decision_kpis_for_pdf,
        _format_substitution_scenarios_for_pdf,
    ],
)
def test_pdf_table_formatters_pass_an_empty_table_through(
    format_table: Callable[[pd.DataFrame], pd.DataFrame],
) -> None:
    table = pd.DataFrame(columns=["category", "kilos_total"])

    formatted = format_table(table)

    pd.testing.assert_frame_equal(formatted, table)
    assert formatted is not table


@pytest.mark.parametrize(
    ("format_table", "column", "expected"),
    [
        (_format_animal_emissions_intensity_for_pdf, "category", "Category"),
        (_format_decision_kpis_for_pdf, "KPI", "Focus"),
        (_format_substitution_scenarios_for_pdf, "scenario", "Scenario"),
    ],
)
def test_pdf_table_formatters_skip_absent_columns(
    format_table: Callable[[pd.DataFrame], pd.DataFrame], column: str, expected: str
) -> None:
    formatted = format_table(pd.DataFrame({column: ["x"], "unlisted": [1]}))

    pd.testing.assert_frame_equal(formatted, pd.DataFrame({expected: ["x"]}))


# ----------------------------------------------------------------------
# Tests for write_report_pdf
# ----------------------------------------------------------------------


def _report(**overrides: Any) -> FoodReport:
    kwargs: dict[str, Any] = {
        "diner_meal_mapping": {"2024-01": 100, "2024-02": 120},
        "mode": "procurement",
        "region": "us",
        "diner_or_meal": "diner",
        "top_n_drivers": 5,
    }
    metric = "servings total" if overrides.get("mode") == "serving" else "kilos_total"
    rows = pd.DataFrame(
        {
            "date": ["2024-01-15", "2024-01-20", "2024-02-15", "2024-02-20"],
            "product": ["Ground Beef", "Lentils", "Ground Beef", "Lentils"],
            "category": ["Beef and Buffalo Meat", "Legumes", "Beef and Buffalo Meat", "Legumes"],
            metric: [10.0, 20.0, 12.0, 18.0],
        }
    )
    return build_food_report(rows, **(kwargs | overrides))


def _capture_pdf_kwargs(
    monkeypatch: pytest.MonkeyPatch,
    report: FoodReport,
    charts: ReportCharts | None = None,
) -> dict[str, Any]:
    captured: dict[str, Any] = {}

    def fake_build_pdf_report(**kwargs: Any) -> str:
        captured.update(kwargs)
        return kwargs["output_path"]

    monkeypatch.setattr(pdf_module, "build_pdf_report", fake_build_pdf_report)
    write_report_pdf(
        report,
        charts or ReportCharts(figures=[], findings=()),
        Path("report.pdf"),
        client_name="Acme",
        baseline_pilot="pilot",
        show_quality_successes=False,
    )
    return captured


def test_write_report_pdf_passes_the_report_to_the_pdf_builder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    report = _report()
    fig = plt.figure()
    chart_finding = {"stage": "plots", "category": "plot_failed", "status": "error"}
    charts = ReportCharts(figures=[("caption", fig)], findings=(chart_finding,))

    kwargs = _capture_pdf_kwargs(monkeypatch, report, charts)
    plt.close(fig)

    findings = [*report.findings, chart_finding]
    tables = kwargs.pop("tables")
    narrative = kwargs.pop("narrative")
    assert kwargs == {
        "output_path": "report.pdf",
        "title_info": {
            "client": "Acme",
            "baseline_pilot": "pilot",
            "procurement_serving": "procurement",
        },
        "plots": [("caption", fig)],
        # A chart finding counts toward the report's quality status.
        "summary_stats": {**report.summary_stats, "Data Quality Status": "INVALID"},
        "quality_status": "invalid",
        "quality_summary": summarize_findings(findings),
        "missing_data_findings": findings,
        "show_quality_successes": False,
        "diner_or_meal": "diner",
    }
    assert list(tables) == [
        "Category Template",
        "Animal Emissions Intensity",
        "Decision KPIs",
        "Substitution Scenarios",
    ]
    pd.testing.assert_frame_equal(
        tables["Decision KPIs"],
        _format_decision_kpis_for_pdf(report.aggregation["decision_kpis"]),
    )
    assert narrative == {
        "client": "Acme",
        "period": "Jan 2024 – Feb 2024",
        "total_food_kg": 60.0,
        "total_co2e_kg": pytest.approx(970.5),
        "per_dm_kg": pytest.approx(970.5 / 220),
        "dm_label": "diner",
        "plant_pct": 63.3,
        "animal_pct": 36.7,
        "top_categories": [
            ("Beef and Buffalo Meat", pytest.approx(100 * 909.7 / 970.5)),
            ("Legumes", pytest.approx(100 * 60.8 / 970.5)),
        ],
        "quality_status": "invalid",
    }


def test_write_report_pdf_serving_has_only_the_template_table_and_no_narrative(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    kwargs = _capture_pdf_kwargs(monkeypatch, _report(mode="serving", diner_or_meal="meal"))

    assert list(kwargs["tables"]) == ["Category Template"]
    assert kwargs["narrative"] is None
    assert kwargs["diner_or_meal"] == "meal"


@pytest.mark.parametrize(
    ("extra_status", "caveat_shown"),
    [(None, False), ("info", False), ("warning", True)],
)
def test_write_report_pdf_caveats_only_a_warning(
    tmp_path: Path, extra_status: str | None, caveat_shown: bool
) -> None:
    report = _report()
    findings = tuple(f for f in report.findings if f["status"] == "success")
    if extra_status is not None:
        findings += ({"status": extra_status, "category": "x", "message": "Extra finding"},)
    path = tmp_path / "report.pdf"

    write_report_pdf(
        replace(report, findings=findings),
        ReportCharts(figures=[], findings=()),
        path,
        client_name="Acme",
        baseline_pilot="pilot",
        show_quality_successes=False,
    )

    pages = ["".join((page.extract_text() or "").split()) for page in PdfReader(str(path)).pages]
    assert ("Somedata-qualitynotesapply" in pages[1]) is caveat_shown
    assert ("Extrafinding" in pages[-1]) is caveat_shown
    assert ("Allautomateddatacheckspassed" in pages[-1]) is not caveat_shown


def test_write_report_pdf_writes_the_pdf(tmp_path: Path) -> None:
    fig = plt.figure()
    path = tmp_path / "report.pdf"

    write_report_pdf(
        _report(),
        ReportCharts(figures=[("caption", fig)], findings=()),
        path,
        client_name="Acme",
        baseline_pilot="pilot",
        show_quality_successes=True,
    )

    assert len(PdfReader(str(path)).pages) > 0
    plt.close(fig)


# ----------------------------------------------------------------------
# Tests for _executive_narrative
# ----------------------------------------------------------------------


def test_executive_narrative_lists_only_the_top_three_categories() -> None:
    report = replace(
        _report(),
        emissions_summary=pd.DataFrame(
            {"category": ["a", "b", "c", "d", "e"], "total_kg_co2e": [1.0, 4.0, np.nan, 3.0, 2.0]}
        ),
    )

    narrative = _executive_narrative(report, "Acme", "pass")

    assert narrative is not None
    assert narrative["total_co2e_kg"] == 10.0
    assert narrative["top_categories"] == [("b", 40.0), ("d", 30.0), ("e", 20.0)]


def test_executive_narrative_leaves_per_unit_and_split_blank_when_unknown() -> None:
    report = replace(_report(), diner_meal_mapping={}, plant_animal_split=None)

    narrative = _executive_narrative(report, "Acme", "pass")

    assert narrative is not None
    assert (narrative["per_dm_kg"], narrative["plant_pct"], narrative["animal_pct"]) == (
        None,
        None,
        None,
    )


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


def test_narrative_paragraphs_skip_the_animal_sentence_on_plant_only_food() -> None:
    rows = pd.DataFrame(
        {
            "date": ["2024-01-15", "2024-02-15"],
            "product": ["Lentils", "Chickpeas"],
            "category": ["Legumes", "Legumes"],
            "kilos_total": [20.0, 18.0],
        }
    )
    report = build_food_report(
        rows,
        diner_meal_mapping={"2024-01": 100, "2024-02": 120},
        mode="procurement",
        region="us",
        diner_or_meal="diner",
        top_n_drivers=5,
    )
    narrative = _executive_narrative(report, "Acme", "pass")
    assert narrative is not None

    paragraphs = _narrative_paragraphs(narrative)

    assert "All of the categorised food was plant-based." in paragraphs
    assert not any("nimal" in paragraph for paragraph in paragraphs)


def test_narrative_paragraphs_describe_a_mixed_split() -> None:
    narrative = _executive_narrative(_report(), "Acme", "pass")
    assert narrative is not None

    paragraphs = _narrative_paragraphs(narrative)

    assert any(
        p.startswith(
            "Plant-based items made up 63% of the categorised food by weight, and animal "
            "products 37%."
        )
        for p in paragraphs
    )
