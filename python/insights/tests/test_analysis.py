import json
from collections.abc import Sequence
from pathlib import Path
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
from gbd_foodservice_insights.testing import KeywordLlmClient

MONTHS = ("2025-01", "2025-02", "2025-03")
KEYWORD_PRODUCTS = (
    "CHEESE CHEDDAR 5LB",
    "Chicken Breast Boneless",
    "Ground Beef 80/20",
    "Pork Loin",
    "Salmon Fillet",
    "Shrimp 21/25",
    "Oat Milk Barista",
    "Whole Milk Gallon",
    "Butter Unsalted",
    "Greek Yogurt",
    "Liquid Egg Whites",
    "Brown Rice",
)
UNKNOWN_PRODUCTS = ("Paper Towels", "Dish Soap")


def _write_csv(path: Path, rows: Sequence[tuple[str, str, float]]) -> None:
    pd.DataFrame(rows, columns=["product", "date", "weight"]).to_csv(path, index=False)


def _sample_rows(products: Sequence[str]) -> list[tuple[str, str, float]]:
    return [(product, f"{month}-15", 10.0) for month in MONTHS for product in products]


def _request(
    tmp_path: Path,
    *,
    counts_basis: CountsBasis = "people",
    unit_system: UnitSystem = "kg",
    site_name: str | None = None,
) -> AnalysisRequest:
    output_directory = tmp_path / "output"
    work_directory = tmp_path / "work"
    output_directory.mkdir(exist_ok=True)
    work_directory.mkdir(exist_ok=True)
    return AnalysisRequest(
        run_id="test-run",
        input_csv=tmp_path / "input.csv",
        output_directory=output_directory,
        work_directory=work_directory,
        report_name=None,
        site_name=site_name,
        organization_name="Acme Foodservice",
        counts_basis=counts_basis,
        unit_system=unit_system,
        monthly_counts=dict.fromkeys(MONTHS, 1000),
    )


@pytest.fixture(autouse=True)
def cache_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Where the categorization cache is read from — absent unless a test writes it, so a
    developer's local copy of the real cache never leaks into these tests."""
    path = tmp_path / "previously_categorized_items.csv"
    monkeypatch.setattr(cache, "_historical_cache_path", lambda: path)
    return path


class FakeReport:
    """Stands in for `run_food_report`, which takes seconds, to check what `analyze()` hands
    it."""

    def __init__(self) -> None:
        self.kwargs: dict[str, Any] = {}

    def __call__(self, **kwargs: Any) -> dict[str, str]:
        self.kwargs = kwargs
        output_dir = Path(kwargs["output_dir"])
        output_dir.mkdir()
        pdf = output_dir / "food_report.pdf"
        xlsx = output_dir / "food_report.xlsx"
        pdf.write_bytes(b"%PDF-fake")
        xlsx.write_bytes(b"PK-fake")
        return {"pdf_path": str(pdf), "client_excel_path": str(xlsx)}

    def input_df(self) -> pd.DataFrame:
        return pd.read_csv(self.kwargs["input_file"])

    def client_metadata(self) -> dict[str, str]:
        return json.loads(
            (Path(self.kwargs["input_file"]).parent / "client_metadata.json").read_text()
        )


@pytest.fixture
def fake_report(monkeypatch: pytest.MonkeyPatch) -> FakeReport:
    fake = FakeReport()
    monkeypatch.setattr(analysis, "run_food_report", fake)
    return fake


def test_analyze_writes_a_real_report_end_to_end(tmp_path: Path) -> None:
    request = _request(tmp_path)
    _write_csv(request.input_csv, _sample_rows(KEYWORD_PRODUCTS + UNKNOWN_PRODUCTS))
    llm = KeywordLlmClient()
    progress_calls = 0

    def count_progress() -> None:
        nonlocal progress_calls
        progress_calls += 1

    outcome = analyze(request, report_progress=count_progress, llm=llm)

    assert outcome.pdf == request.output_directory / "report.pdf"
    assert outcome.xlsx == request.output_directory / "report.xlsx"
    assert outcome.pdf.read_bytes()[:4] == b"%PDF"
    assert {"Monthly by Product", "Monthly by Category", "Emissions Summary"} <= set(
        pd.ExcelFile(outcome.xlsx).sheet_names
    )
    # One per LLM call, plus one per `run_food_report` stage.
    assert llm.calls
    assert progress_calls == len(llm.calls) + 15


def test_hands_the_report_the_categorized_rows_and_drops_unknowns(
    tmp_path: Path, fake_report: FakeReport
) -> None:
    request = _request(tmp_path)
    _write_csv(request.input_csv, _sample_rows(("Cheddar Cheese", "Dish Soap", "Chicken Thigh")))

    analyze(request, llm=KeywordLlmClient())

    assert fake_report.input_df().to_dict("records") == [
        {"date": f"{month}-15", "product": product, "category": category, "kilos_total": 10.0}
        for month in MONTHS
        for product, category in (
            ("Cheddar Cheese", "Cheese"),
            ("Chicken Thigh", "Poultry (Chicken & Turkey)"),
        )
    ]


def test_converts_pounds_to_kilograms(tmp_path: Path, fake_report: FakeReport) -> None:
    request = _request(tmp_path, unit_system="lb")
    _write_csv(request.input_csv, [("Cheddar Cheese", "2025-01-15", 10.0)])

    analyze(request, llm=KeywordLlmClient())

    assert fake_report.input_df()["kilos_total"].tolist() == [pytest.approx(10 * LB_TO_KG)]


@pytest.mark.parametrize(
    ("counts_basis", "site_name", "diner_or_meal", "client"),
    [
        ("people", None, "diner", "Acme Foodservice"),
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
    _write_csv(request.input_csv, [("Cheddar Cheese", "2025-01-15", 10.0)])

    analyze(request, llm=KeywordLlmClient())

    assert fake_report.kwargs["diner_or_meal"] == diner_or_meal
    assert fake_report.kwargs["diner_meal_mapping"] == dict.fromkeys(MONTHS, 1000)
    assert fake_report.client_metadata() == {
        "client": client,
        "baseline_pilot": "baseline",
        "procurement_serving": "procurement",
    }


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
    _write_csv(
        request.input_csv, [("House Blend 7", "2025-01-15", 1.0), ("Pork Loin", "2025-01-15", 1.0)]
    )
    llm = KeywordLlmClient()

    analyze(request, llm=llm)

    assert {item for _, item in llm.calls} == {"Pork Loin", "pork loin"}
    assert fake_report.input_df()["category"].tolist() == ["Cheese", "Pork (pig meat)"]


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (b"", "not a readable UTF-8 CSV"),
        (b"product,date,weight\n\xff\xfe,2025-01-15,1\n", "not a readable UTF-8 CSV"),
        (b"product,weight,date\nCheese,1,2025-01-15\n", "has columns"),
        (b"product,date,weight\n", "has no rows"),
        (b"product,date,weight\nCheese,2025-01-15,1\n  ,2025-01-15,1\n", "line 3 has an empty"),
        (b"product,date,weight\nCheese,01/15/2025,1\n", "line 2 has a date"),
        (b"product,date,weight\nCheese,2025-1-15,1\n", "line 2 has a date"),
        (b"product,date,weight\nCheese,2025-02-30,1\n", "line 2 has a date"),
        (b"product,date,weight\nCheese,2025-01-15,\n", "line 2 has a weight"),
        (b"product,date,weight\nCheese,2025-01-15,5 lb\n", "line 2 has a weight"),
        (b"product,date,weight\nCheese,2025-01-15,-1\n", "line 2 has a weight"),
        (b"product,date,weight\nCheese,2025-01-15,inf\n", "line 2 has a weight"),
    ],
)
def test_rejects_input_that_breaks_the_contract(
    tmp_path: Path, content: bytes, message: str
) -> None:
    request = _request(tmp_path)
    request.input_csv.write_bytes(content)
    llm = KeywordLlmClient()

    with pytest.raises(InvalidInputError, match=message):
        analyze(request, llm=llm)
    assert llm.calls == []


def test_a_product_named_like_a_missing_value_is_still_a_product(
    tmp_path: Path, fake_report: FakeReport
) -> None:
    request = _request(tmp_path)
    request.input_csv.write_text("product,date,weight\nNA,2025-01-15,1\nCheese,2025-01-15,1\n")
    llm = KeywordLlmClient()

    analyze(request, llm=llm)

    assert ("clean", "NA") in llm.calls


def test_data_with_almost_no_recognizable_products_is_unusable(tmp_path: Path) -> None:
    request = _request(tmp_path)
    _write_csv(request.input_csv, _sample_rows(UNKNOWN_PRODUCTS))

    with pytest.raises(UnusableDataError, match="Over 80% of products were eliminated"):
        analyze(request, llm=KeywordLlmClient())


class UnreachableLlmClient:
    def clean_product_name(self, item: str) -> str:
        raise UpstreamApiError("OpenAI failed 5 times")

    def match_product_to_category(self, item: str, categories: Sequence[str]) -> str:
        raise UpstreamApiError("OpenAI failed 5 times")

    def fuzzy_match_category(self, item: str, categories: Sequence[str]) -> str:
        raise UpstreamApiError("OpenAI failed 5 times")


def test_an_upstream_failure_propagates(tmp_path: Path) -> None:
    request = _request(tmp_path)
    _write_csv(request.input_csv, _sample_rows(KEYWORD_PRODUCTS))

    with pytest.raises(UpstreamApiError, match="OpenAI failed 5 times"):
        analyze(request, llm=UnreachableLlmClient())
