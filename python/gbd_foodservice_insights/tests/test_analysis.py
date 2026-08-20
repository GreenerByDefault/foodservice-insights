from decimal import Decimal
from pathlib import Path

import pytest
from gbd_foodservice_insights.analysis import AiUsage, AnalysisRequest, analyze


def _request(tmp_path: Path) -> AnalysisRequest:
    return AnalysisRequest(
        run_id="test-run",
        input_csv=tmp_path / "input.csv",
        artifacts_directory=tmp_path,
        work_directory=tmp_path,
        report_name=None,
        site_name=None,
        counts_basis="people",
        unit_system="lb",
        monthly_counts={"2025-01": 100},
    )


def test_analyze_raises_not_implemented(tmp_path: Path) -> None:
    with pytest.raises(NotImplementedError):
        analyze(_request(tmp_path))


def test_ai_usage_cost_is_a_decimal() -> None:
    usage = AiUsage(
        model="gpt-4.1-mini",
        input_tokens=1,
        output_tokens=1,
        cost_usd=Decimal("0.0001"),
        metadata={},
    )

    assert usage.cost_usd == Decimal("0.0001")
