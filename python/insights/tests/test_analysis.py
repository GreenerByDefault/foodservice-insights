import dataclasses
import json
import math
import os
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from types import MappingProxyType
from typing import Any

import pandas as pd
import pytest
from gbd_foodservice_insights import analysis
from gbd_foodservice_insights.analysis import (
    LB_TO_KG,
    AnalysisRequest,
    CountsBasis,
    InvalidInputError,
    UnitSystem,
    UnusableDataError,
    UpstreamApiError,
    analyze,
)
from gbd_foodservice_insights.categorization import cache
from gbd_foodservice_insights.report import pdf
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


def _request(
    tmp_path: Path,
    *,
    counts_basis: CountsBasis = "people",
    unit_system: UnitSystem = "kg",
    site_name: str | None = None,
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
        counts_basis=counts_basis,
        unit_system=unit_system,
        # Not a `dict`: `worker_child` hands over a read-only view.
        monthly_counts=MappingProxyType(dict.fromkeys(SAMPLE_MONTHS, 1000)),
    )


@pytest.fixture(autouse=True)
def cache_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Where the categorization cache is read from — absent unless a test writes it, so a
    developer's local copy of the real cache never leaks into these tests."""
    path = tmp_path / "previously_categorized_items.csv"
    monkeypatch.setattr(cache, "categorization_cache_path", lambda: path)
    return path


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
        return object()

    @contextmanager
    def build_report_charts(self, report: object) -> Iterator[object]:
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

    def count_progress() -> None:
        nonlocal progress_calls
        progress_calls += 1

    outcome = analyze(request, report_progress=count_progress, llm=llm)

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
        "Decision_KPIs",
        "Substitution_Scenarios",
    ]
    assert workbook["Diners"].to_dict("records") == [
        {"month_year": month, "diners": 1000} for month in SAMPLE_MONTHS
    ]
    # One per LLM call, plus one per `build_food_report` stage and one before each of the
    # charts, the PDF and the workbook.
    assert llm.calls
    assert progress_calls == len(llm.calls) + 11


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


def test_analyze_golden_deliverables(
    tmp_path: Path, cache_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pins what the PDF is built from and every workbook sheet. `UPDATE_GOLDEN=1` rewrites
    the fixture, whose diff is then the review. The PDF's own bytes are not compared: the
    title page is dated and its fonts vary by machine."""
    baseline = pd.read_csv(Path(__file__).parent / "data" / "aggregated_baseline.csv")
    baseline = baseline[baseline["category"].notna() & (baseline["category"] != "No Matches Found")]
    baseline.assign(cleaned_item_names=baseline["product"].str.lower())[
        ["product", "category", "cleaned_item_names"]
    ].drop_duplicates("product").to_csv(cache_path, index=False)
    request = dataclasses.replace(
        _request(tmp_path),
        monthly_counts=MappingProxyType({"2023-10": 900, "2023-11": 1000, "2023-12": 1100}),
    )
    request.input_csv.write_text(
        input_csv_text(baseline[["product", "date", "kilos_total"]].itertuples(index=False))
    )

    pdf_inputs: dict[str, Any] = {}
    build_pdf_report = pdf.build_pdf_report

    def record_pdf_inputs(**kwargs: Any) -> str:
        pdf_inputs.update(
            {
                "title_info": kwargs["title_info"],
                "summary_stats": kwargs["summary_stats"],
                "quality_status": kwargs["quality_status"],
                "quality_summary": kwargs["quality_summary"],
                "narrative": kwargs["narrative"],
                "tables": kwargs["tables"],
                "findings": kwargs["missing_data_findings"],
                "chart_titles": [_chart_titles(figure) for _, figure in kwargs["plots"]],
            }
        )
        return build_pdf_report(**kwargs)

    monkeypatch.setattr(pdf, "build_pdf_report", record_pdf_inputs)
    llm = KeywordLlmClient()

    outcome = analyze(request, llm=llm)

    assert llm.calls == []
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

    analyze(request, llm=KeywordLlmClient())

    assert fake_report.rows["kilos_total"].tolist() == [pytest.approx(10 * LB_TO_KG)]


@pytest.mark.parametrize(
    ("counts_basis", "site_name", "diner_or_meal", "client"),
    [
        ("people", None, "diner", "Acme Foodservice"),
        ("people", "", "diner", "Acme Foodservice"),
        ("meals", "North Campus", "meal", "Acme Foodservice — North Campus"),
    ],
)
def test_hands_the_report_the_forms_answers(
    tmp_path: Path,
    fake_report: FakeReport,
    counts_basis: CountsBasis,
    site_name: str | None,
    diner_or_meal: str,
    client: str,
) -> None:
    request = _request(tmp_path, counts_basis=counts_basis, site_name=site_name)
    request.input_csv.write_text(input_csv_text([("Cheddar Cheese", "2025-01-15", 10.0)]))

    def report_progress() -> None:
        pass

    analyze(request, report_progress=report_progress, llm=KeywordLlmClient())

    assert fake_report.kwargs == {
        "diner_meal_mapping": request.monthly_counts,
        "mode": "procurement",
        "region": "us",
        "diner_or_meal": diner_or_meal,
        "top_n_drivers": 5,
        "report_progress": report_progress,
    }
    assert fake_report.pdf_kwargs == {
        "client_name": client,
        "baseline_pilot": "baseline",
        "show_quality_successes": False,
    }


# ----------------------------------------------------------------------
# Tests for progress reporting and the categorization cache
# ----------------------------------------------------------------------


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


def test_a_cached_product_skips_the_llm(
    tmp_path: Path, cache_path: Path, fake_report: FakeReport
) -> None:
    pd.DataFrame(
        {
            "product": ["House Blend 7"],
            "category": ["Cheese"],
            "cleaned_item_names": ["house blend"],
        }
    ).to_csv(cache_path, index=False)
    request = _request(tmp_path)
    request.input_csv.write_text(
        input_csv_text([("House Blend 7", "2025-01-15", 1.0), ("Pork Loin", "2025-01-15", 1.0)])
    )
    llm = KeywordLlmClient()

    analyze(request, llm=llm)

    assert llm.calls == [("clean", "Pork Loin"), ("match", "pork loin")]
    assert fake_report.rows["category"].tolist() == ["Cheese", "Pork (pig meat)"]


# ----------------------------------------------------------------------
# Tests for input validation and upstream failures
# ----------------------------------------------------------------------


def test_rejects_input_that_breaks_the_contract_before_any_llm_call(tmp_path: Path) -> None:
    request = _request(tmp_path)
    request.input_csv.write_text("product,date,weight\nCheese,01/15/2025,1\n")
    llm = KeywordLlmClient()

    with pytest.raises(InvalidInputError, match="line 2 has a date"):
        analyze(request, llm=llm)
    assert llm.calls == []


def test_data_with_almost_no_recognizable_products_is_unusable(tmp_path: Path) -> None:
    request = _request(tmp_path)
    request.input_csv.write_text(sample_input_csv(UNKNOWN_PRODUCTS))

    with pytest.raises(UnusableDataError, match="Over 80% of products were eliminated"):
        analyze(request, llm=KeywordLlmClient())


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
