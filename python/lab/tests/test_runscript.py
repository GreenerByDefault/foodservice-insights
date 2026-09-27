import importlib.util
import sys
from pathlib import Path

import pandas as pd


def _load_categorize_runscript_module():
    script_path = Path(__file__).resolve().parents[1] / "runscripts" / "1. Categorize Runscript.py"
    spec = importlib.util.spec_from_file_location("categorize_runscript", script_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_produce_food_report_runscript_module():
    script_path = Path(__file__).resolve().parents[1] / "runscripts" / "2. Produce Food Report.py"
    spec = importlib.util.spec_from_file_location("produce_food_report_runscript", script_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _summary(output_file: str) -> dict:
    return {
        "n_products_before": 1,
        "n_products_after": 1,
        "pct_remaining": 1.0,
        "n_rows_before": 1,
        "n_rows_after": 1,
        "row_elimination_details": {},
        "output_file": output_file,
        "human_review_file": output_file.replace(".csv", "_for_human_review.csv"),
    }


def test_runscript_sets_none_cache_mode_for_baseline(monkeypatch, tmp_path):
    """
    Asserts baseline runs avoid writing AI outputs into cache, preserving manual-review
    workflows. This matters because cache mode controls whether AI labels are safely
    reviewed before reuse.
    """
    module = _load_categorize_runscript_module()
    input_path = tmp_path / "input.csv"
    input_path.write_text("product,date,weight\napple,2025-01-01,1\n")

    called = {}

    def _fake_categorize(**kwargs):
        called.update(kwargs)
        return pd.DataFrame(), _summary(str(input_path))

    monkeypatch.setattr(module, "categorize_spreadsheet_to_csvs", _fake_categorize)
    monkeypatch.setattr(
        module,
        "setup_api_clients",
        lambda **_: {"gemini_client": object()},
    )
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(module, "load_dotenv", lambda **_: None)
    monkeypatch.setattr(module, "update_metadata_with_categorization_stats", lambda _: None)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "1. Categorize Runscript.py",
            "--input",
            str(input_path),
            "--analysis-context",
            "baseline",
        ],
    )

    module.main()

    assert called["cache_write_mode"] == "none"


def test_runscript_sets_unreviewed_cache_mode_for_web_app(monkeypatch, tmp_path):
    """
    Asserts web app runs route AI labels to unreviewed cache so only approved labels are
    promoted.
    """
    module = _load_categorize_runscript_module()
    input_path = tmp_path / "input.csv"
    input_path.write_text("product,date,weight\napple,2025-01-01,1\n")

    called = {}

    def _fake_categorize(**kwargs):
        called.update(kwargs)
        return pd.DataFrame(), _summary(str(input_path))

    monkeypatch.setattr(module, "categorize_spreadsheet_to_csvs", _fake_categorize)
    monkeypatch.setattr(
        module,
        "setup_api_clients",
        lambda **_: {"gemini_client": object()},
    )
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(module, "load_dotenv", lambda **_: None)
    monkeypatch.setattr(module, "update_metadata_with_categorization_stats", lambda _: None)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "1. Categorize Runscript.py",
            "--input",
            str(input_path),
            "--analysis-context",
            "web_app",
            "--data-type",
            "procurement",
        ],
    )

    module.main()

    assert called["cache_write_mode"] == "web_app_unreviewed"


def test_produce_food_report_runscript_passes_input_and_diner_meals_straight_through(
    monkeypatch, tmp_path
):
    """Every client folder's copy of step 1.5 launches this CLI with --input and
    --diner-meals; pin that contract so it keeps mapping onto run_food_report's keyword
    arguments."""
    module = _load_produce_food_report_runscript_module()
    input_path = tmp_path / "categorized.csv"
    diner_meals_path = tmp_path / "diner_meals.json"

    called = {}

    def _fake_run_food_report(**kwargs):
        called.update(kwargs)
        return {
            "pdf_path": "report.pdf",
            "client_excel_path": "report.xlsx",
            "qa_excel_path": "report_qa.xlsx",
            "manifest_path": "report_manifest.json",
            "log_path": "report.log",
            "diagnostics": [],
            "quality_status": "pass",
            "summary": {},
        }

    monkeypatch.setattr(module, "run_food_report", _fake_run_food_report)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "2. Produce Food Report.py",
            "--input",
            str(input_path),
            "--diner-meals",
            str(diner_meals_path),
        ],
    )

    module.main()

    assert called["input_file"] == str(input_path)
    assert called["diner_meal_file"] == str(diner_meals_path)
