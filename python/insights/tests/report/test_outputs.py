from dataclasses import replace
from pathlib import Path
from typing import Any

import pandas as pd
from gbd_foodservice_insights.report.excel import diner_meals_frame, write_client_workbook
from gbd_foodservice_insights.report.food_report import FoodReport, build_food_report


def _report(**overrides: Any) -> FoodReport:
    kwargs: dict[str, Any] = {
        "diner_meal_mapping": {"2024-01": 100, "2024-02": 120},
        "mode": "procurement",
        "region": "us",
        "diner_or_meal": "diner",
        "top_n_drivers": 5,
    }
    metric = "servings total" if overrides.get("mode") == "serving" else "kilos_total"
    rows = pd.DataFrame(
        {
            "date": pd.to_datetime(["2024-01-15", "2024-02-20"]),
            "product": ["Ground Beef", "Lentils"],
            "category": ["Beef and Buffalo Meat", "Legumes"],
            metric: [10.0, 20.0],
        }
    )
    return build_food_report(rows, **(kwargs | overrides))


def test_write_client_workbook_excludes_internal_tabs(tmp_path: Path):
    output_path = tmp_path / "client.xlsx"

    write_client_workbook(_report(), output_path)

    sheets = pd.read_excel(output_path, sheet_name=None)
    assert list(sheets) == [
        "Monthly by Product",
        "Monthly by Category",
        "Template",
        "Diners",
        "Emissions Summary",
        "Animal Emissions Intensity",
        "Decision_KPIs",
        "Substitution_Scenarios",
    ]
    assert sheets["Template"].columns.tolist() == ["category", "2024-01", "2024-02", "total"]
    pd.testing.assert_frame_equal(
        sheets["Diners"], pd.DataFrame({"month_year": ["2024-01", "2024-02"], "diners": [100, 120]})
    )


def test_write_client_workbook_serving_omits_the_emissions_tabs(tmp_path: Path):
    output_path = tmp_path / "client.xlsx"

    write_client_workbook(_report(mode="serving", diner_or_meal="meal"), output_path)

    assert pd.ExcelFile(output_path).sheet_names == [
        "Monthly by Product",
        "Monthly by Category",
        "Template",
        "Meals",
    ]


def test_diner_meals_frame_keeps_its_columns_without_a_mapping():
    report = replace(_report(diner_or_meal="meal"), diner_meal_mapping={})

    pd.testing.assert_frame_equal(
        diner_meals_frame(report),
        pd.DataFrame(columns=["month_year", "meals"], dtype=object),
    )
