import json
from pathlib import Path

import pytest
from gbd_foodservice_insights.categorization import cache
from gbd_foodservice_insights.testing import sample_input_csv
from support.contract_fixtures import VALID_ANALYSIS_ATTEMPT_ID
from worker_child.contract import layout, names
from worker_child.mock_llm import main


@pytest.fixture(autouse=True)
def absent_caches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Points the categorization caches at files that do not exist, so the LLM calls made here
    do not depend on the developer's local copy of GBD's cache."""
    monkeypatch.setattr(cache, "_historical_cache_path", lambda: tmp_path / "absent.csv")
    monkeypatch.setattr(cache, "_web_app_unreviewed_cache_path", lambda: tmp_path / "absent.csv")


def test_main_with_no_arguments_is_a_usage_error(capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = main(["worker_child.mock_llm"])

    assert exit_code == names.EXIT_USAGE_ERROR
    assert "usage" in capsys.readouterr().err.lower()


def test_main_runs_a_real_analysis_with_no_api_key(
    run_directory: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    (run_directory / layout.INPUT_CSV).write_text(sample_input_csv(), encoding="utf-8")

    exit_code = main(["worker_child.mock_llm", str(run_directory)])

    assert exit_code == names.EXIT_WROTE_RESULT
    files = run_directory / layout.RESULT_FILES_DIRECTORY
    assert (files / layout.PDF_FILE_NAME).read_bytes()[:4] == b"%PDF"
    assert (files / layout.XLSX_FILE_NAME).read_bytes()[:2] == b"PK"
    result = json.loads((run_directory / layout.RESULT).read_text(encoding="utf-8"))
    assert result == {"analysisAttemptId": VALID_ANALYSIS_ATTEMPT_ID}
