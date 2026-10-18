import dataclasses
import json
import math
import os
import re
from collections.abc import Generator, Sequence
from contextlib import contextmanager
from pathlib import Path
from types import MappingProxyType, SimpleNamespace
from typing import Any

import pandas as pd
import pytest
from gbd_foodservice_insights import analysis
from gbd_foodservice_insights.analysis import (
    LB_TO_KG,
    AnalysisRequest,
    CachedCategorization,
    CategorizationSummary,
    InputSummary,
    InvalidInputError,
    ListedFinding,
    LlmCall,
    MonthlyCounts,
    NewCategorization,
    ReportSummary,
    StageFinished,
    Telemetry,
    UnitSystem,
    UnusableDataError,
    UpstreamApiError,
    analyze,
)
from gbd_foodservice_insights.categorization.llm import OnLlmCall
from gbd_foodservice_insights.report import pdf
from gbd_foodservice_insights.report.food_report import FindingCount, FoodReport, ReportCharts
from gbd_foodservice_insights.report.quality import Finding
from gbd_foodservice_insights.report.schema import Headcounts, quality_status_from_findings
from gbd_foodservice_insights.testing import (
    KEYWORD_PRODUCTS,
    SAMPLE_MONTHS,
    UNKNOWN_PRODUCTS,
    KeywordLlmClient,
    input_csv_text,
    sample_input_csv,
)
from matplotlib.figure import Figure

# ----------------------------------------------------------------------
# Shared fixtures
# ----------------------------------------------------------------------


# Not a `dict`: `worker_child` hands over a read-only view.
SAMPLE_COUNTS = MonthlyCounts("people", MappingProxyType(dict.fromkeys(SAMPLE_MONTHS, 1000)))


def _request(
    tmp_path: Path,
    *,
    counts: MonthlyCounts | None = SAMPLE_COUNTS,
    unit_system: UnitSystem = "kg",
    site_name: str | None = None,
    categorization_cache: tuple[CachedCategorization, ...] = (),
) -> AnalysisRequest:
    output_directory = tmp_path / "output"
    output_directory.mkdir(exist_ok=True)
    return AnalysisRequest(
        run_id="test-run",
        input_csv=tmp_path / "input.csv",
        output_directory=output_directory,
        report_name=None,
        site_name=site_name,
        organization_name="Acme Foodservice",
        counts=counts,
        unit_system=unit_system,
        categorization_cache=categorization_cache,
    )


FAKE_REPORT_SUMMARY = ReportSummary(
    quality_status="warning",
    finding_counts=(FindingCount("date_distribution", "warning", 2),),
    total_co2e_kg=12.5,
    co2e_kg_per_diner_or_meal=0.25,
    plant_pct_by_weight=40.0,
    plant_protein_pct_by_weight=None,
)


class FakeReport:
    """Stands in for `build_food_report` and the writers after it, which take seconds, to check
    what `analyze()` hands them."""

    def __init__(self) -> None:
        self.rows = pd.DataFrame()
        self.kwargs: dict[str, Any] = {}
        self.pdf_kwargs: dict[str, Any] = {}

    def build_food_report(self, rows: pd.DataFrame, **kwargs: Any) -> object:
        self.rows = rows
        self.kwargs = kwargs
        return SimpleNamespace(findings=[])

    def summarize_report(self, report: object) -> ReportSummary:
        return FAKE_REPORT_SUMMARY

    @contextmanager
    def build_report_charts(self, report: object) -> Generator[object]:
        yield object()

    def write_report_pdf(self, report: object, charts: object, path: Path, **kwargs: Any) -> None:
        self.pdf_kwargs = kwargs
        path.write_bytes(b"%PDF-fake")

    def write_client_workbook(self, report: object, path: Path) -> None:
        path.write_bytes(b"PK-fake")


@pytest.fixture
def fake_report(monkeypatch: pytest.MonkeyPatch) -> FakeReport:
    fake = FakeReport()
    for name in (
        "build_food_report",
        "summarize_report",
        "build_report_charts",
        "write_report_pdf",
        "write_client_workbook",
    ):
        monkeypatch.setattr(analysis, name, getattr(fake, name))
    return fake


# ----------------------------------------------------------------------
# Tests for analyze()'s deliverables
# ----------------------------------------------------------------------


def test_analyze_writes_a_real_report_end_to_end(tmp_path: Path) -> None:
    request = _request(tmp_path)
    request.input_csv.write_text(sample_input_csv())
    llm = KeywordLlmClient()
    progress_calls = 0
    reported: list[Telemetry] = []

    def count_progress() -> None:
        nonlocal progress_calls
        progress_calls += 1

    outcome = analyze(
        request, report_progress=count_progress, report_telemetry=reported.append, llm=llm
    )

    assert outcome.pdf == request.output_directory / "report.pdf"
    assert outcome.xlsx == request.output_directory / "report.xlsx"
    assert outcome.pdf.read_bytes()[:4] == b"%PDF"
    workbook = pd.read_excel(outcome.xlsx, sheet_name=None)
    assert list(workbook) == [
        "Monthly by Product",
        "Monthly by Category",
        "Template",
        "Diners",
        "Emissions Summary",
        "Animal Emissions Intensity",
        "Decision KPIs",
        "Substitution Scenarios",
    ]
    assert workbook["Diners"].to_dict("records") == [
        {"month_year": month, "diners": 1000} for month in SAMPLE_MONTHS
    ]
    # One per LLM call, plus one per `build_food_report` stage and one before each of the
    # charts, the PDF and the workbook.
    assert llm.calls
    assert progress_calls == len(llm.calls) + 10
    (summary,) = [record for record in reported if isinstance(record, ReportSummary)]
    assert summary.quality_status == "pass"
    assert summary.total_co2e_kg > 0


def test_analyze_without_counts_writes_a_totals_only_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = _request(tmp_path, counts=None)
    request.input_csv.write_text(sample_input_csv())
    chart_titles: list[list[str]] = []
    write_report_pdf = analysis.write_report_pdf

    def record_chart_titles(
        report: FoodReport, charts: ReportCharts, *args: Any, **kwargs: Any
    ) -> None:
        chart_titles.extend(_chart_titles(figure) for figure in charts.figures)
        write_report_pdf(report, charts, *args, **kwargs)

    monkeypatch.setattr(analysis, "write_report_pdf", record_chart_titles)

    outcome = analyze(request, llm=KeywordLlmClient())

    # The pages after these never use counts.
    assert chart_titles[:4] == [
        ["Kilos Over Time", "Total Kilos"],
        ["Kilos by Category Across All Months"],
        ["Carbon Emissions by Category"],
        ["Carbon Emissions Over Time", "Total Carbon Emissions Over Time"],
    ]
    assert list(pd.read_excel(outcome.xlsx, sheet_name=None)) == [
        "Monthly by Product",
        "Monthly by Category",
        "Template",
        "Emissions Summary",
        "Animal Emissions Intensity",
        "Decision KPIs",
        "Substitution Scenarios",
    ]


class NaIsCheeseLlmClient(KeywordLlmClient):
    def match_product_to_category(self, item: str, categories: Sequence[str]) -> str:
        return "Cheese" if item == "na" else super().match_product_to_category(item, categories)


def test_a_product_named_like_a_missing_value_survives(tmp_path: Path) -> None:
    request = _request(tmp_path)
    request.input_csv.write_text(sample_input_csv(("NA", *KEYWORD_PRODUCTS)))

    outcome = analyze(request, llm=NaIsCheeseLlmClient())

    products = pd.read_excel(outcome.xlsx, sheet_name="Monthly by Product", keep_default_na=False)
    assert "NA" in products["product"].tolist()


def test_a_product_bought_at_zero_weight_still_reports(tmp_path: Path) -> None:
    request = _request(tmp_path)
    request.input_csv.write_text(
        input_csv_text(
            (product, f"{month}-15", 0.0 if product == "Pork Loin" else 10.0)
            for month in SAMPLE_MONTHS
            for product in KEYWORD_PRODUCTS
        )
    )

    outcome = analyze(request, llm=KeywordLlmClient())

    products = pd.read_excel(outcome.xlsx, sheet_name="Monthly by Product")
    assert products.loc[products["product"] == "Pork Loin", "kilos_total"].tolist() == [0.0] * 3


def test_identical_lines_each_count_toward_the_report(tmp_path: Path) -> None:
    request = _request(tmp_path)
    rows = [
        (product, f"{month}-15", 10.0) for month in SAMPLE_MONTHS for product in KEYWORD_PRODUCTS
    ]
    rice_in_january = ("Brown Rice", f"{SAMPLE_MONTHS[0]}-15", 10.0)
    request.input_csv.write_text(input_csv_text([*rows, rice_in_january, rice_in_january]))

    outcome = analyze(request, llm=KeywordLlmClient())

    products = pd.read_excel(outcome.xlsx, sheet_name="Monthly by Product")
    assert products.loc[products["product"] == "Brown Rice", "kilos_total"].tolist() == [
        30.0,
        10.0,
        10.0,
    ]


def _headcount_finding(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    counts: dict[str, int],
    weight_by_month: dict[str, float],
) -> Finding:
    """The headcount finding `analyze()` hands the PDF, buying `weight_by_month[month]` of every
    product each month."""
    request = _request(tmp_path, counts=MonthlyCounts("people", MappingProxyType(counts)))
    request.input_csv.write_text(
        input_csv_text(
            (product, f"{month}-15", weight)
            for month, weight in weight_by_month.items()
            for product in KEYWORD_PRODUCTS
        )
    )
    pdf_findings: list[Finding] = []
    write_report_pdf = analysis.write_report_pdf

    def record_findings(report: FoodReport, *args: Any, **kwargs: Any) -> None:
        pdf_findings.extend(report.findings)
        write_report_pdf(report, *args, **kwargs)

    monkeypatch.setattr(analysis, "write_report_pdf", record_findings)

    analyze(request, llm=KeywordLlmClient())

    return next(f for f in pdf_findings if f["category"] == "diner_meal_count_reasonableness")


SCHOOL_YEAR = [f"2025-{month:02d}" for month in range(1, 13)]


def test_a_school_year_whose_purchases_fall_with_its_summer_counts_has_no_headcount_warning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    summer = ("2025-07", "2025-08")
    headcount = _headcount_finding(
        tmp_path,
        monkeypatch,
        counts={month: 300 if month in summer else 1000 for month in SCHOOL_YEAR},
        weight_by_month={month: 3.0 if month in summer else 10.0 for month in SCHOOL_YEAR},
    )

    assert headcount["status"] == "success"


def test_a_mistyped_count_reports_with_a_headcount_warning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    headcount = _headcount_finding(
        tmp_path,
        monkeypatch,
        counts={month: 10_000 if month == "2025-03" else 1000 for month in SCHOOL_YEAR},
        weight_by_month=dict.fromkeys(SCHOOL_YEAR, 10.0),
    )

    assert (headcount["status"], headcount["count"], headcount["sample_values"]) == (
        "warning",
        1,
        [
            (
                "Mar 2025: 10,000 diners, against 1,000 in a typical month, with no matching "
                "rise in food."
            )
        ],
    )


def test_every_pdf_page_is_letter_even_with_a_product_name_at_the_webs_cap(
    tmp_path: Path,
) -> None:
    request = _request(tmp_path)
    long_name = "Cheddar Cheese Sharp Yellow Shredded Fancy " * 5
    request.input_csv.write_text(sample_input_csv((long_name[:200], *KEYWORD_PRODUCTS)))

    outcome = analyze(request, llm=KeywordLlmClient())

    # matplotlib writes each page's dictionary uncompressed, in points.
    pdf_bytes = outcome.pdf.read_bytes()
    page_count = int(re.findall(rb"/Count (\d+)", pdf_bytes)[-1])
    page_sizes = re.findall(rb"/Type /Page .*?/MediaBox \[ 0 0 (\S+) (\S+) \]", pdf_bytes)
    assert len(page_sizes) == page_count
    assert set(page_sizes) == {(b"612", b"792"), (b"792", b"612")}


GOLDEN_PATH = Path(__file__).parent / "data" / "analysis_golden.json"


def _jsonable(value: Any) -> Any:
    """`value` as plain JSON, with floats rounded so the last bits of a sum cannot fail the
    comparison."""
    if isinstance(value, pd.DataFrame):
        return _jsonable(
            json.loads(value.to_json(orient="split", date_format="iso", default_handler=str))
        )
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_jsonable(v) for v in value]
    if isinstance(value, float):
        return value if not math.isfinite(value) or value == 0 else float(f"{value:.9g}")
    if value is None or isinstance(value, bool | int | str):
        return value
    return str(value)


def _chart_titles(figure: Figure) -> list[str]:
    suptitle = figure.get_suptitle()
    titles = [ax.get_title() for ax in figure.axes if ax.get_title()]
    return [suptitle, *titles] if suptitle else titles


def test_analyze_golden_deliverables(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Pins what the PDF is built from and every workbook sheet. `UPDATE_GOLDEN=1` rewrites
    the fixture, whose diff is then the review. The PDF's own bytes are not compared: the
    title page is dated and its fonts vary by machine."""
    baseline = pd.read_csv(Path(__file__).parent / "data" / "aggregated_baseline.csv")
    baseline = baseline[baseline["category"].notna() & (baseline["category"] != "No Matches Found")]
    cached = baseline.drop_duplicates("product")
    request = _request(
        tmp_path,
        counts=MonthlyCounts(
            "people", MappingProxyType({"2023-10": 900, "2023-11": 1000, "2023-12": 1100})
        ),
        categorization_cache=tuple(
            CachedCategorization(product, category, product.lower())
            for product, category in zip(cached["product"], cached["category"], strict=True)
        ),
    )
    request.input_csv.write_text(
        input_csv_text(baseline[["product", "date", "kilos_total"]].itertuples(index=False))
    )

    pdf_inputs: dict[str, Any] = {}
    write_report_pdf = analysis.write_report_pdf

    def record_pdf_inputs(
        report: FoodReport, charts: ReportCharts, path: Path, *, client_name: str, **kwargs: Any
    ) -> None:
        procurement = report.aggregation
        assert procurement.animal_emissions_intensity is not None
        assert procurement.animal_emissions_concentration is not None
        assert procurement.substitution_scenarios is not None
        narrative = pdf._executive_narrative(
            report, client_name, quality_status_from_findings(report.findings)
        )
        pdf_inputs.update(
            {
                "title": client_name,
                "narrative": dataclasses.asdict(narrative),
                "tables": {
                    "Category Template": pdf._format_category_template_for_pdf(
                        report.aggregation.template
                    ),
                    "Animal Emissions Intensity": pdf._format_animal_emissions_intensity_for_pdf(
                        procurement.animal_emissions_intensity
                    ),
                    "Decision KPIs": dataclasses.asdict(procurement.animal_emissions_concentration),
                    "Substitution Scenarios": pdf._format_substitution_scenarios_for_pdf(
                        procurement.substitution_scenarios
                    ),
                },
                "findings": report.findings,
                "chart_titles": [_chart_titles(figure) for figure in charts.figures],
            }
        )
        write_report_pdf(report, charts, path, client_name=client_name, **kwargs)

    monkeypatch.setattr(analysis, "write_report_pdf", record_pdf_inputs)
    llm = KeywordLlmClient()

    outcome = analyze(request, llm=llm)

    assert llm.calls == []
    assert outcome.new_categorizations == ()
    actual = _jsonable(
        {"pdf": pdf_inputs, "workbook": pd.read_excel(outcome.xlsx, sheet_name=None)}
    )
    if os.environ.get("UPDATE_GOLDEN"):
        GOLDEN_PATH.write_text(json.dumps(actual, indent=2, ensure_ascii=False) + "\n")
    assert actual == json.loads(GOLDEN_PATH.read_text())


# ----------------------------------------------------------------------
# Tests for what analyze() hands the report
# ----------------------------------------------------------------------


def test_hands_the_report_the_categorized_rows_and_drops_unknowns(
    tmp_path: Path, fake_report: FakeReport
) -> None:
    request = _request(tmp_path)
    request.input_csv.write_text(sample_input_csv(("Cheddar Cheese", "Dish Soap", "Chicken Thigh")))

    analyze(request, llm=KeywordLlmClient())

    pd.testing.assert_frame_equal(
        fake_report.rows,
        pd.DataFrame(
            [
                {
                    "date": pd.Timestamp(f"{month}-15"),
                    "product": product,
                    "category": category,
                    "kilos_total": 10.0,
                }
                for month in SAMPLE_MONTHS
                for product, category in (
                    ("Cheddar Cheese", "Cheese"),
                    ("Chicken Thigh", "Poultry (Chicken & Turkey)"),
                )
            ]
        ),
    )


def test_converts_pounds_to_kilograms(tmp_path: Path, fake_report: FakeReport) -> None:
    request = _request(tmp_path, unit_system="lb")
    request.input_csv.write_text(input_csv_text([("Cheddar Cheese", "2025-01-15", 10.0)]))

    reported: list[Telemetry] = []

    analyze(request, report_telemetry=reported.append, llm=KeywordLlmClient())

    assert fake_report.rows["kilos_total"].tolist() == [pytest.approx(10 * LB_TO_KG)]
    (input_summary,) = [record for record in reported if isinstance(record, InputSummary)]
    (categorization,) = [record for record in reported if isinstance(record, CategorizationSummary)]
    assert (input_summary.kilograms, categorization.categorized_kilograms) == pytest.approx(
        (10 * LB_TO_KG, 10 * LB_TO_KG)
    )


SAMPLE_PERIODS = dict.fromkeys(pd.PeriodIndex(SAMPLE_MONTHS, freq="M"), 1000.0)


@pytest.mark.parametrize(
    ("counts", "site_name", "headcounts", "client"),
    [
        (SAMPLE_COUNTS, None, Headcounts("diner", SAMPLE_PERIODS), "Acme Foodservice"),
        (SAMPLE_COUNTS, "", Headcounts("diner", SAMPLE_PERIODS), "Acme Foodservice"),
        (
            dataclasses.replace(SAMPLE_COUNTS, basis="meals"),
            "North Campus",
            Headcounts("meal", SAMPLE_PERIODS),
            "Acme Foodservice — North Campus",
        ),
        (None, None, None, "Acme Foodservice"),
    ],
)
def test_hands_the_report_the_forms_answers(
    tmp_path: Path,
    fake_report: FakeReport,
    counts: MonthlyCounts | None,
    site_name: str | None,
    headcounts: Headcounts | None,
    client: str,
) -> None:
    request = _request(tmp_path, counts=counts, site_name=site_name)
    request.input_csv.write_text(input_csv_text([("Cheddar Cheese", "2025-01-15", 10.0)]))

    def report_progress() -> None:
        pass

    analyze(request, report_progress=report_progress, llm=KeywordLlmClient())

    assert fake_report.kwargs == {
        "headcounts": headcounts,
        "region": "us",
        "top_n_drivers": 5,
        "report_progress": report_progress,
    }
    assert fake_report.pdf_kwargs == {
        "client_name": client,
        "show_quality_successes": False,
    }


# ----------------------------------------------------------------------
# Tests for progress and telemetry reporting, and the categorization cache
# ----------------------------------------------------------------------


def test_the_default_llm_reports_its_calls_as_telemetry(
    tmp_path: Path, fake_report: FakeReport, monkeypatch: pytest.MonkeyPatch
) -> None:
    received: list[OnLlmCall] = []

    def from_env(*, on_call: OnLlmCall) -> KeywordLlmClient:
        received.append(on_call)
        return KeywordLlmClient()

    monkeypatch.setattr(analysis.OpenAiLlmClient, "from_env", from_env)
    request = _request(tmp_path)
    request.input_csv.write_text(input_csv_text([("Cheddar Cheese", "2025-01-15", 1.0)]))
    reported: list[Telemetry] = []

    analyze(request, report_telemetry=reported.append)

    assert received == [reported.append]


def test_a_passed_llm_reports_no_calls(tmp_path: Path, fake_report: FakeReport) -> None:
    request = _request(tmp_path)
    request.input_csv.write_text(input_csv_text([("Cheddar Cheese", "2025-01-15", 1.0)]))
    reported: list[Telemetry] = []

    analyze(request, report_telemetry=reported.append, llm=KeywordLlmClient())

    assert reported
    assert [record for record in reported if isinstance(record, LlmCall)] == []


class MysteryMeatLlmClient(KeywordLlmClient):
    def match_product_to_category(self, item: str, categories: Sequence[str]) -> str:
        answer = super().match_product_to_category(item, categories)
        return "Meat" if item == "mystery meat" else answer


def test_reports_each_stages_summary_and_time_in_order(
    tmp_path: Path, fake_report: FakeReport
) -> None:
    request = _request(
        tmp_path,
        categorization_cache=(
            CachedCategorization("House Blend 7", "Cheese", "house blend"),
            CachedCategorization("Paper Towels", "No Matches Found", "paper towels"),
            CachedCategorization("OTHER PORK SKU", "Pork (pig meat)", "pork loin"),
        ),
    )
    request.input_csv.write_text(
        sample_input_csv(
            (
                "House Blend 7",
                "Paper Towels",
                "Pork Loin",
                " Pork Loin",
                "Chicken Thigh",
                "Dish Soap",
                "Mystery Meat",
            )
        )
    )
    reported: list[Telemetry] = []

    analyze(request, report_telemetry=reported.append, llm=MysteryMeatLlmClient())

    assert _without_times(reported) == [
        StageFinished("read", duration_ms=0),
        InputSummary(rows=21, kilograms=210.0, unique_products=6, categorization_cache_entries=3),
        StageFinished("categorize", duration_ms=0),
        CategorizationSummary(
            cache_raw_name_products=2,
            cache_cleaned_name_products=1,
            llm_matched_products=3,
            cache_no_match_products=1,
            llm_no_match_products=2,
            unrecognized_llm_answers=1,
            categorized_rows=12,
            categorized_kilograms=120.0,
        ),
        FAKE_REPORT_SUMMARY,
        StageFinished("report", duration_ms=0),
        StageFinished("pdf", duration_ms=0),
        StageFinished("xlsx", duration_ms=0),
    ]


def _without_times(reported: Sequence[Telemetry]) -> list[Telemetry]:
    """Zeroes each stage's time, which varies from run to run."""
    return [
        dataclasses.replace(record, duration_ms=0) if isinstance(record, StageFinished) else record
        for record in reported
    ]


def test_reports_progress_after_every_llm_call(tmp_path: Path, fake_report: FakeReport) -> None:
    request = _request(tmp_path)
    request.input_csv.write_text(input_csv_text([("Cheddar Cheese", "2025-01-15", 1.0)]))
    llm = KeywordLlmClient()
    progress: list[int] = []

    analyze(request, report_progress=lambda: progress.append(len(llm.calls)), llm=llm)

    # Each report comes after its call has been recorded. The last three are `analyze()`'s own,
    # before the charts, the PDF and the workbook.
    assert progress == [1, 2, 2, 2, 2]
    assert llm.calls == [("clean", "Cheddar Cheese"), ("match", "cheddar cheese")]


def test_a_cached_product_skips_the_llm(tmp_path: Path, fake_report: FakeReport) -> None:
    request = _request(
        tmp_path,
        categorization_cache=(CachedCategorization("House Blend 7", "Cheese", "house blend"),),
    )
    request.input_csv.write_text(
        input_csv_text([("House Blend 7", "2025-01-15", 1.0), ("Pork Loin", "2025-01-15", 1.0)])
    )
    llm = KeywordLlmClient()

    analyze(request, llm=llm)

    assert llm.calls == [("clean", "Pork Loin"), ("match", "pork loin")]
    assert fake_report.rows["category"].tolist() == ["Cheese", "Pork (pig meat)"]


def test_hands_back_exactly_the_products_the_llm_categorized(
    tmp_path: Path, fake_report: FakeReport
) -> None:
    request = _request(
        tmp_path,
        categorization_cache=(CachedCategorization("House Blend 7", "Cheese", "house blend"),),
    )
    request.input_csv.write_text(
        input_csv_text(
            [
                ("House Blend 7", "2025-01-15", 1.0),
                ("Pork Loin!", "2025-01-15", 1.0),
                ("Dish Soap", "2025-01-15", 1.0),
            ]
        )
    )

    outcome = analyze(request, llm=KeywordLlmClient())

    assert outcome.new_categorizations == (
        NewCategorization("Pork Loin!", "pork loin", "Pork (pig meat)"),
        NewCategorization("Dish Soap", "dish soap", "No Matches Found"),
    )


def test_hands_back_the_warnings_the_pdf_lists(tmp_path: Path) -> None:
    request = _request(tmp_path, counts=None)
    request.input_csv.write_text(
        input_csv_text(
            (product, f"{month}-15", 10.0)
            for month in ("2025-01", "2025-03")
            for product in KEYWORD_PRODUCTS
        )
    )

    outcome = analyze(request, llm=KeywordLlmClient())

    assert outcome.findings == (
        ListedFinding(
            quality_check="missing_internal_months",
            status="warning",
            message=(
                "Found 1 missing internal month between Jan 2025 and Mar 2025: Feb 2025. In a "
                "three-month report window, that means one-third of the expected period is "
                "missing."
            ),
            sample_values=("Feb 2025",),
        ),
    )


# ----------------------------------------------------------------------
# Tests for input validation and upstream failures
# ----------------------------------------------------------------------


def test_rejects_input_that_breaks_the_contract_before_any_llm_call(tmp_path: Path) -> None:
    request = _request(tmp_path)
    request.input_csv.write_text("product,date,weight\nCheese,01/15/2025,1\n")
    llm = KeywordLlmClient()

    reported: list[Telemetry] = []

    with pytest.raises(InvalidInputError, match="line 2 has a date"):
        analyze(request, report_telemetry=reported.append, llm=llm)
    assert llm.calls == []
    assert reported == []


def test_data_with_almost_no_recognizable_products_is_unusable_and_reports_why(
    tmp_path: Path,
) -> None:
    request = _request(tmp_path)
    request.input_csv.write_text(sample_input_csv(UNKNOWN_PRODUCTS))
    reported: list[Telemetry] = []

    with pytest.raises(UnusableDataError, match="Over 80% of products were eliminated"):
        analyze(request, report_telemetry=reported.append, llm=KeywordLlmClient())
    # No time for the failed "report" stage, and no cache file, so an empty cache.
    assert _without_times(reported) == [
        StageFinished("read", duration_ms=0),
        InputSummary(rows=6, kilograms=60.0, unique_products=2, categorization_cache_entries=0),
        StageFinished("categorize", duration_ms=0),
        CategorizationSummary(
            cache_raw_name_products=0,
            cache_cleaned_name_products=0,
            llm_matched_products=2,
            cache_no_match_products=0,
            llm_no_match_products=2,
            unrecognized_llm_answers=0,
            categorized_rows=0,
            categorized_kilograms=0.0,
        ),
    ]


def test_data_whose_recognizable_products_weigh_nothing_is_unusable(tmp_path: Path) -> None:
    request = _request(tmp_path)
    request.input_csv.write_text(
        input_csv_text(
            (product, f"{month}-15", 10.0 if product in UNKNOWN_PRODUCTS else 0.0)
            for month in SAMPLE_MONTHS
            for product in KEYWORD_PRODUCTS + UNKNOWN_PRODUCTS
        )
    )

    with pytest.raises(UnusableDataError, match="Every row has a kilos_total of 0"):
        analyze(request, llm=KeywordLlmClient())


class UnreachableLlmClient:
    def clean_product_name(self, item: str) -> str:
        raise UpstreamApiError("OpenAI failed 5 times")

    def match_product_to_category(self, item: str, categories: Sequence[str]) -> str:
        raise UpstreamApiError("OpenAI failed 5 times")


def test_an_upstream_failure_propagates(tmp_path: Path) -> None:
    request = _request(tmp_path)
    request.input_csv.write_text(sample_input_csv(KEYWORD_PRODUCTS))

    with pytest.raises(UpstreamApiError, match="OpenAI failed 5 times"):
        analyze(request, llm=UnreachableLlmClient())
