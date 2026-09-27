import json
from pathlib import Path

import pandas as pd
import pytest
from gbd_foodservice_insights_lab.food_report.pipeline import run_food_report


@pytest.fixture
def food_report_tmp_data(tmp_path: Path):
    input_df = pd.DataFrame(
        {
            "date": ["2024-01-05", "bad date"],
            "product": ["tofu", "beef"],
            "category": ["legumes", "beef and buffalo meat"],
            "kilos_total": [10.0, 5.0],
        }
    )

    input_path = tmp_path / "categorized_test.csv"
    input_df.to_csv(input_path, index=False)

    diner_path = tmp_path / "diner_meals.json"
    diner_path.write_text(json.dumps({"2024-01": 1000}))

    metadata_path = tmp_path / "client_metadata.json"
    metadata_path.write_text(
        json.dumps(
            {
                "client": "Test Client",
                "baseline_pilot": "baseline",
                "procurement_serving": "procurement",
            }
        )
    )

    return input_path, diner_path


def test_run_food_report_warn_continue_returns_quality_payload(
    monkeypatch, food_report_tmp_data, tmp_path
):
    """Checks warn-continue mode returns quality metadata needed for downstream diagnostics/UI
    display."""
    input_path, diner_path = food_report_tmp_data

    monkeypatch.setattr(
        "gbd_foodservice_insights.report.pdf.build_pdf_report",
        lambda **kwargs: str(tmp_path / "out.pdf"),
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights.report.excel.write_client_workbook",
        lambda report, path: None,
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights_lab.food_report.excel.build_qa_excel_report",
        lambda **kwargs: str(tmp_path / "out_qa.xlsx"),
    )

    result = run_food_report(
        input_file=input_path,
        diner_meal_file=diner_path,
        output_dir=tmp_path,
        procurement_serving="procurement",
        missing_data_policy="warn_continue",
    )

    assert "quality_status" in result
    assert "missing_data_findings" in result
    assert "quality_summary" in result
    assert result["quality_status"] in {"warning", "invalid"}


def test_run_food_report_fails_on_a_missing_diner_meal_file_even_under_warn_continue(
    food_report_tmp_data, tmp_path
):
    input_path, _ = food_report_tmp_data

    with pytest.raises(FileNotFoundError, match="Diner-meal JSON not found"):
        run_food_report(
            input_file=input_path,
            diner_meal_file=tmp_path / "missing.json",
            output_dir=tmp_path,
            procurement_serving="procurement",
            missing_data_policy="warn_continue",
        )


def test_run_food_report_flags_unexpected_row_loss_in_emissions_stage(
    monkeypatch, food_report_tmp_data, tmp_path
):
    """Warn-continue mode should still surface silent row loss as an invalid-quality run."""
    input_path, diner_path = food_report_tmp_data

    def fake_calculate_emissions(df, **kwargs):
        out = df.iloc[:-1].copy()
        out["emission_factor_used"] = 1.0
        out["emissions_kg_co2e"] = 1.0
        return out, []

    monkeypatch.setattr(
        "gbd_foodservice_insights.emissions.calculate_emissions",
        fake_calculate_emissions,
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights.report.pdf.build_pdf_report",
        lambda **kwargs: str(tmp_path / "out.pdf"),
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights.report.excel.write_client_workbook",
        lambda report, path: None,
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights_lab.food_report.excel.build_qa_excel_report",
        lambda **kwargs: str(tmp_path / "out_qa.xlsx"),
    )

    result = run_food_report(
        input_file=input_path,
        diner_meal_file=diner_path,
        output_dir=tmp_path,
        procurement_serving="procurement",
        missing_data_policy="warn_continue",
    )

    row_drift_finding = next(
        finding
        for finding in result["missing_data_findings"]
        if finding.get("category") == "row_count_drift" and finding.get("stage") == "emissions"
    )

    assert row_drift_finding["status"] == "error"
    assert row_drift_finding["metadata"]["before_rows"] == 2
    assert row_drift_finding["metadata"]["after_rows"] == 1
    assert result["quality_status"] == "invalid"


def test_run_food_report_hard_fail_raises_on_required_missing(monkeypatch, tmp_path):
    """Checks hard-fail mode blocks report generation when required fields are missing. This
    matters because report pipeline contracts must remain stable across ingestion, quality
    checks, and outputs."""
    bad_df = pd.DataFrame(
        {
            "date": ["2024-01-01"],
            "category": ["legumes"],
            "kilos_total": [1.0],
        }
    )
    input_path = tmp_path / "categorized_bad.csv"
    bad_df.to_csv(input_path, index=False)

    diner_path = tmp_path / "diner_meals.json"
    diner_path.write_text(json.dumps({"2024-01": 1000}))

    (tmp_path / "client_metadata.json").write_text("{}")

    monkeypatch.setattr(
        "gbd_foodservice_insights.report.pdf.build_pdf_report",
        lambda **kwargs: str(tmp_path / "out.pdf"),
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights.report.excel.write_client_workbook",
        lambda report, path: None,
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights_lab.food_report.excel.build_qa_excel_report",
        lambda **kwargs: str(tmp_path / "out_qa.xlsx"),
    )

    with pytest.raises(ValueError, match="hard_fail"):
        run_food_report(
            input_file=input_path,
            diner_meal_file=diner_path,
            output_dir=tmp_path,
            procurement_serving="procurement",
            missing_data_policy="hard_fail",
        )
