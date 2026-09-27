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


def test_categorize_runscript_passes_its_arguments_straight_through(monkeypatch, tmp_path):
    module = _load_categorize_runscript_module()
    input_path = tmp_path / "input.csv"
    gemini_client = object()

    called = {}

    def _fake_categorize(**kwargs):
        called.update(kwargs)
        return pd.DataFrame(), _summary(str(input_path))

    monkeypatch.setattr(module, "categorize_spreadsheet_to_csvs", _fake_categorize)
    monkeypatch.setattr(module, "setup_api_clients", lambda **_: {"gemini_client": gemini_client})
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
            "--data-type",
            "serving",
            "--date-format",
            "%b-%y",
        ],
    )

    module.main()

    llm = called.pop("llm")
    assert isinstance(llm, module.OpenAiLlmClient)
    assert called == {
        "input_filepath": str(input_path),
        "output_filepath": None,
        "data_type": "serving",
        "gemini_client": gemini_client,
        "date_format": "%b-%y",
    }


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
