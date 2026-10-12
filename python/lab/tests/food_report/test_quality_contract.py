import json
from pathlib import Path
from typing import NoReturn

import pandas as pd
import pytest
from gbd_foodservice_insights_lab.food_report import pipeline, serving
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


@pytest.mark.parametrize(
    ("mode", "metric", "module", "builder"),
    [
        ("procurement", "kilos_total", pipeline, "build_food_report"),
        ("serving", "servings total", serving, "build_serving_report"),
    ],
)
def test_run_food_report_hands_the_report_a_numeric_metric(
    monkeypatch, tmp_path, mode: str, metric: str, module: object, builder: str
):
    input_path = tmp_path / "categorized_test.csv"
    pd.DataFrame(
        {
            "date": ["2024-01-05", "2024-01-06"],
            "product": ["tofu", "beef stew"],
            "category": ["legumes", "beef and buffalo meat"],
            metric: ["1,234", "5"],
        }
    ).to_csv(input_path, index=False)
    handed: list[pd.DataFrame] = []

    def fake_build(rows: pd.DataFrame, **_: object) -> NoReturn:
        handed.append(rows)
        raise _StopRun

    monkeypatch.setattr(module, builder, fake_build)

    with pytest.raises(_StopRun):
        run_food_report(
            input_file=input_path,
            diner_meal_mapping={"2024-01": 1000},
            output_dir=tmp_path,
            procurement_serving=mode,
        )

    assert handed[0][metric].tolist() == [1234.0, 5.0]


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


# `clean_weight_column` turns a weight it cannot parse into NaN rather than raising.
@pytest.mark.parametrize(
    ("rows", "message"),
    [
        (
            {"date": ["2024-01-01"], "category": ["Legumes"], "kilos_total": [1.0]},
            "Missing required columns: product",
        ),
        (
            {
                "date": ["2024-01-01", "2024-01-02"],
                "product": ["tofu", "lentils"],
                "category": ["Legumes", "Legumes"],
                "kilos_total": ["1.5", "n/a"],
            },
            "kilos_total is missing in 1 of 2 rows",
        ),
    ],
)
def test_run_food_report_names_the_problem_with_unusable_rows(
    rows: dict[str, list[object]], message: str, tmp_path: Path
):
    input_path = tmp_path / "categorized_bad.csv"
    pd.DataFrame(rows).to_csv(input_path, index=False)

    with pytest.raises(ValueError, match=message):
        run_food_report(
            input_file=input_path,
            diner_meal_mapping={"2024-01": 1000},
            output_dir=tmp_path,
            procurement_serving="procurement",
        )
