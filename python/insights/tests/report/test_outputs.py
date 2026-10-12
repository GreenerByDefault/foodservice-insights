from pathlib import Path
from typing import Any

import pandas as pd
from gbd_foodservice_insights.report.excel import diner_meals_frame, write_client_workbook
from gbd_foodservice_insights.report.food_report import FoodReport, build_food_report

JAN, FEB = pd.period_range("2024-01", periods=2, freq="M")


def _report(**overrides: Any) -> FoodReport:
    kwargs: dict[str, Any] = {
        "diner_meal_mapping": {JAN: 100, FEB: 120},
        "region": "us",
        "diner_or_meal": "diner",
        "top_n_drivers": 5,
    }
    rows = pd.DataFrame(
        {
            "date": pd.to_datetime(["2024-01-15", "2024-02-20"]),
            "product": ["Ground Beef", "Lentils"],
            "category": ["Beef and Buffalo Meat", "Legumes"],
            "kilos_total": [10.0, 20.0],
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
        "Decision KPIs",
        "Substitution Scenarios",
    ]
    assert sheets["Template"].columns.tolist() == ["category", "2024-01", "2024-02", "total"]
    pd.testing.assert_frame_equal(
        sheets["Diners"], pd.DataFrame({"month_year": ["2024-01", "2024-02"], "diners": [100, 120]})
    )


def test_diner_meals_frame_keeps_its_columns_without_a_mapping():
    pd.testing.assert_frame_equal(
        diner_meals_frame({}, "meal"),
        pd.DataFrame(columns=["month_year", "meals"], dtype=object),
    )
