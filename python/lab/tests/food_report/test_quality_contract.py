import json
from pathlib import Path
from typing import NoReturn

import pandas as pd
import pytest
from gbd_foodservice_insights.report.quality import QualityCheckError
from gbd_foodservice_insights_lab.food_report import pipeline
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


def test_run_food_report_writes_a_failed_manifest_on_a_bad_date(food_report_tmp_data, tmp_path):
    input_path, diner_path = food_report_tmp_data

    with pytest.raises(ValueError, match="bad date") as excinfo:
        run_food_report(
            input_file=input_path,
            diner_meal_file=diner_path,
            output_dir=tmp_path,
            procurement_serving="procurement",
        )

    manifest = json.loads((tmp_path / "food_report_test_manifest.json").read_text())
    assert manifest["run_status"] == "failed"
    assert manifest["error_message"] == str(excinfo.value)
    assert manifest["quality_status"] is None


def test_run_food_report_hands_the_report_a_numeric_metric(monkeypatch, tmp_path):
    input_path = tmp_path / "categorized_serving.csv"
    pd.DataFrame(
        {
            "date": ["2024-01-05", "2024-01-06"],
            "product": ["tofu", "beef stew"],
            "category": ["legumes", "beef and buffalo meat"],
            "servings total": ["1,234", "5"],
        }
    ).to_csv(input_path, index=False)
    handed: list[pd.DataFrame] = []

    def fake_build_food_report(rows: pd.DataFrame, **_: object) -> NoReturn:
        handed.append(rows)
        raise _StopRun

    monkeypatch.setattr(pipeline, "build_food_report", fake_build_food_report)

    with pytest.raises(_StopRun):
        run_food_report(
            input_file=input_path,
            diner_meal_mapping={"2024-01": 1000},
            output_dir=tmp_path,
            procurement_serving="serving",
        )

    assert handed[0]["servings total"].tolist() == [1234.0, 5.0]


class _StopRun(Exception):
    pass


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
