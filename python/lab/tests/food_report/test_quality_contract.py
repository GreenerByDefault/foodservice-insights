import json
from pathlib import Path

import pandas as pd
import pytest
from gbd_foodservice_insights.report.quality import QualityCheckError
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


def test_run_food_report_writes_a_failed_manifest_when_a_check_aborts(
    food_report_tmp_data, tmp_path
):
    input_path, diner_path = food_report_tmp_data

    with pytest.raises(QualityCheckError, match=r"\[date_normalization::date_parse_failure\]"):
        run_food_report(
            input_file=input_path,
            diner_meal_file=diner_path,
            output_dir=tmp_path,
            procurement_serving="procurement",
        )

    manifest = json.loads((tmp_path / "food_report_test_manifest.json").read_text())
    assert manifest["run_status"] == "failed"
    assert manifest["quality_status"] == "invalid"


def test_run_food_report_fails_on_a_missing_diner_meal_file(food_report_tmp_data, tmp_path):
    input_path, _ = food_report_tmp_data

    with pytest.raises(FileNotFoundError, match="Diner-meal JSON not found"):
        run_food_report(
            input_file=input_path,
            diner_meal_file=tmp_path / "missing.json",
            output_dir=tmp_path,
            procurement_serving="procurement",
        )


def test_run_food_report_raises_on_a_missing_required_column(monkeypatch, tmp_path):
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

    with pytest.raises(QualityCheckError, match=r"\[ingestion::required_columns\]"):
        run_food_report(
            input_file=input_path,
            diner_meal_file=diner_path,
            output_dir=tmp_path,
            procurement_serving="procurement",
        )
