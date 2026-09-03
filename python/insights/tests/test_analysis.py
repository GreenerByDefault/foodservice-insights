from pathlib import Path

import pytest
from gbd_foodservice_insights.analysis import AnalysisRequest, analyze


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


def test_analyze_raises_not_implemented(tmp_path: Path) -> None:
    with pytest.raises(NotImplementedError):
        analyze(_request(tmp_path))
