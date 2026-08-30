from decimal import Decimal
from pathlib import Path

import pytest
from gbd_foodservice_insights.analysis import (
    AnalysisError,
    AnalysisRequest,
    UnusableDataError,
    UpstreamApiError,
)
from gbd_foodservice_insights.testing import PDF_MAGIC_BYTES, XLSX_MAGIC_BYTES, stub_analysis


def _request(tmp_path: Path) -> AnalysisRequest:
    return AnalysisRequest(
        run_id="test-run",
        input_csv=tmp_path / "input.csv",
        output_directory=tmp_path,
        work_directory=tmp_path,
        report_name=None,
        site_name=None,
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


def test_stub_analysis_can_report_a_cost(tmp_path: Path) -> None:
    outcome = stub_analysis(_request(tmp_path), cost_usd=Decimal("1234.5678"))
    assert outcome.ai.cost_usd == Decimal("1234.5678")


@pytest.mark.parametrize("error", [UpstreamApiError, UnusableDataError])
def test_stub_analysis_can_raise_on_demand(tmp_path: Path, error: type[AnalysisError]) -> None:
    with pytest.raises(error):
        stub_analysis(_request(tmp_path), raises=error)


def test_stub_analysis_writes_nothing_when_it_raises(tmp_path: Path) -> None:
    with pytest.raises(UpstreamApiError):
        stub_analysis(_request(tmp_path), raises=UpstreamApiError)
    assert list(tmp_path.iterdir()) == []
