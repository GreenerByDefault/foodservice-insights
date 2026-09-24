from pathlib import Path

import pytest
from gbd_foodservice_insights.analysis import (
    AnalysisError,
    AnalysisRequest,
    UnusableDataError,
    UpstreamApiError,
)
from gbd_foodservice_insights.categories import get_GBD_categories
from gbd_foodservice_insights.testing import (
    KEYWORD_CATEGORIES,
    PDF_MAGIC_BYTES,
    XLSX_MAGIC_BYTES,
    KeywordLlmClient,
    stub_analysis,
)


def _request(tmp_path: Path) -> AnalysisRequest:
    return AnalysisRequest(
        run_id="test-run",
        input_csv=tmp_path / "input.csv",
        output_directory=tmp_path,
        work_directory=tmp_path,
        report_name=None,
        site_name=None,
        organization_name="Acme Foodservice",
        counts_basis="people",
        unit_system="lb",
        monthly_counts={"2025-01": 100},
    )


def test_stub_analysis_writes_exactly_what_it_declares(tmp_path: Path) -> None:
    outcome = stub_analysis(_request(tmp_path))
    assert outcome.pdf.read_bytes() == PDF_MAGIC_BYTES
    assert outcome.xlsx.read_bytes() == XLSX_MAGIC_BYTES


def test_stub_analysis_can_omit_the_pdf(tmp_path: Path) -> None:
    outcome = stub_analysis(_request(tmp_path), write_pdf=False)
    assert not outcome.pdf.exists()


def test_stub_analysis_can_omit_the_xlsx(tmp_path: Path) -> None:
    outcome = stub_analysis(_request(tmp_path), write_xlsx=False)
    assert not outcome.xlsx.exists()


def test_stub_analysis_reports_progress_the_requested_number_of_times(tmp_path: Path) -> None:
    calls = 0

    def count() -> None:
        nonlocal calls
        calls += 1

    stub_analysis(_request(tmp_path), report_progress=count, progress_calls=3)

    assert calls == 3


@pytest.mark.parametrize("error", [UpstreamApiError, UnusableDataError])
def test_stub_analysis_can_raise_on_demand(tmp_path: Path, error: type[AnalysisError]) -> None:
    with pytest.raises(error):
        stub_analysis(_request(tmp_path), raises=error)


def test_stub_analysis_writes_nothing_when_it_raises(tmp_path: Path) -> None:
    with pytest.raises(UpstreamApiError):
        stub_analysis(_request(tmp_path), raises=UpstreamApiError)
    assert list(tmp_path.iterdir()) == []


def test_keyword_table_names_only_gbd_categories() -> None:
    gbd_categories = set(get_GBD_categories())
    assert {category for _, category in KEYWORD_CATEGORIES} <= gbd_categories


def test_keyword_table_has_no_unreachable_keywords() -> None:
    keywords = [keyword for keyword, _ in KEYWORD_CATEGORIES]
    shadowed = [
        (earlier, later)
        for i, later in enumerate(keywords)
        for earlier in keywords[:i]
        if earlier in later
    ]
    assert shadowed == []


def test_keyword_llm_client_prefers_the_specific_keyword() -> None:
    llm = KeywordLlmClient()
    assert llm.match_product_to_category("Oat Milk Barista", []) == "Oat Milk"
    assert llm.match_product_to_category("2% Milk", []) == "Milk (Cow's milk)"
    assert llm.match_product_to_category("paper napkins", []) == "No Matches Found"


def test_keyword_llm_client_cleans_names() -> None:
    assert KeywordLlmClient().clean_product_name(" CHKN Breast (12) 5LB ") == "chkn breast lb"


def test_keyword_llm_client_fuzzy_matches_to_the_closest_category() -> None:
    llm = KeywordLlmClient()
    assert llm.fuzzy_match_category("Chese", ["Cheese", "Butter"]) == "Cheese"
    assert llm.fuzzy_match_category("zzz", ["Cheese", "Butter"]) == "No Matches Found"


def test_keyword_llm_client_records_every_call() -> None:
    llm = KeywordLlmClient()
    llm.clean_product_name("a")
    llm.match_product_to_category("b", [])
    llm.fuzzy_match_category("c", [])
    assert llm.calls == [("clean", "a"), ("match", "b"), ("fuzzy", "c")]
