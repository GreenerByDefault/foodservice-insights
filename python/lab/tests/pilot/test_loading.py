from pathlib import Path

import pandas as pd
import pytest
from gbd_foodservice_insights.report.food_report import build_food_report
from gbd_foodservice_insights.report.metric import KILOS
from gbd_foodservice_insights.report.schema import DinerOrMeal
from gbd_foodservice_insights_lab.food_report import pipeline
from gbd_foodservice_insights_lab.food_report.serving import SERVINGS, build_serving_report
from gbd_foodservice_insights_lab.pilot.analysis import (
    load_all_pilot_data,
    load_diner_meal_data,
    load_monthly_category_data,
)

BASELINE_JAN, BASELINE_FEB = pd.period_range("2024-01", periods=2, freq="M")
PILOT_JAN, PILOT_FEB = pd.period_range("2025-01", periods=2, freq="M")
BEEF = "Beef and Buffalo Meat"
LEGUMES = "Legumes"
BEEF_LOWER, LEGUMES_LOWER = BEEF.lower(), LEGUMES.lower()


def _rows(rows: list[tuple[pd.Period, str, str, float]], metric_column: str) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "date": [month.to_timestamp() + pd.Timedelta(days=14) for month, *_ in rows],
            "product": [product for _, product, _, _ in rows],
            "category": [category for _, _, category, _ in rows],
            metric_column: [amount for *_, amount in rows],
        }
    )


def _write_qa_workbook(
    path: Path,
    rows: list[tuple[pd.Period, str, str, float]],
    counts: dict[pd.Period, float],
    *,
    diner_or_meal: DinerOrMeal = "diner",
    serving: bool = False,
) -> str:
    report = (
        build_serving_report(
            _rows(rows, SERVINGS.column),
            diner_meal_mapping=counts,
            diner_or_meal=diner_or_meal,
            top_n_drivers=5,
        )
        if serving
        else build_food_report(
            _rows(rows, KILOS.column),
            diner_meal_mapping=counts,
            region="us",
            diner_or_meal=diner_or_meal,
            top_n_drivers=5,
        )
    )
    return pipeline._write_qa_workbook(
        report,
        str(path),
        metric=SERVINGS if serving else KILOS,
        quality_findings=[],
        potential_name_splits=pd.DataFrame(),
        category_discontinuity=pd.DataFrame(),
    )


def _write_pair(tmp_path: Path, *, diner_or_meal: DinerOrMeal = "diner") -> tuple[str, str]:
    baseline = _write_qa_workbook(
        tmp_path / "baseline_qa.xlsx",
        [
            (BASELINE_JAN, "Ground Beef", BEEF, 10),
            (BASELINE_JAN, "Ground Beef", BEEF, 2),
            (BASELINE_FEB, "Lentils", LEGUMES, 4),
        ],
        {BASELINE_JAN: 100, BASELINE_FEB: 200},
        diner_or_meal=diner_or_meal,
    )
    pilot = _write_qa_workbook(
        tmp_path / "pilot_qa.xlsx",
        [(PILOT_JAN, "Lentils", LEGUMES, 8), (PILOT_FEB, "Chickpeas", LEGUMES, 6)],
        {PILOT_JAN: 100, PILOT_FEB: 150},
        diner_or_meal=diner_or_meal,
    )
    return baseline, pilot


@pytest.mark.parametrize("diner_or_meal", ["diner", "meal"])
def test_load_all_pilot_data_reads_step_2_qa_workbooks(tmp_path: Path, diner_or_meal: DinerOrMeal):
    data = load_all_pilot_data(*_write_pair(tmp_path, diner_or_meal=diner_or_meal))

    pd.testing.assert_frame_equal(
        data["monthly_category_data"][
            ["month_year", "category", "kilos_total", "kilos per diner-meal", "period"]
        ],
        pd.DataFrame(
            {
                "month_year": ["2024-01", "2024-02", "2025-01", "2025-02"],
                "category": [BEEF_LOWER, LEGUMES_LOWER, LEGUMES_LOWER, LEGUMES_LOWER],
                "kilos_total": [12, 4, 8, 6],
                "kilos per diner-meal": [0.12, 0.02, 0.08, 0.04],
                "period": ["baseline", "baseline", "pilot", "pilot"],
            }
        ),
    )
    pd.testing.assert_frame_equal(
        data["monthly_product_data"][["month_year", "product", "kilos_total", "period"]],
        pd.DataFrame(
            {
                "month_year": ["2024-01", "2024-02", "2025-01", "2025-02"],
                "product": ["Ground Beef", "Lentils", "Lentils", "Chickpeas"],
                "kilos_total": [12, 4, 8, 6],
                "period": ["baseline", "baseline", "pilot", "pilot"],
            }
        ),
    )
    pd.testing.assert_frame_equal(
        data["diner_meal_data"],
        pd.DataFrame(
            {
                "month_year": ["2024-01", "2024-02", "2025-01", "2025-02"],
                "diner-meals": [100, 200, 100, 150],
                "period": ["baseline", "baseline", "pilot", "pilot"],
            }
        ),
    )
    pd.testing.assert_frame_equal(
        data["monthly_product_category_data"],
        pd.DataFrame(
            {
                "month_year": ["2024-01", "2024-02", "2025-01", "2025-02"],
                "product": ["Ground Beef", "Lentils", "Lentils", "Chickpeas"],
                "category": [BEEF_LOWER, LEGUMES_LOWER, LEGUMES_LOWER, LEGUMES_LOWER],
                "kilos_total": [12, 4, 8, 6],
                "period": ["baseline", "baseline", "pilot", "pilot"],
            }
        ),
    )
    # Legumes had no rows in the baseline's first month, which the Template leaves empty.
    pd.testing.assert_series_equal(
        data["template_data"].set_index("category").loc[LEGUMES_LOWER],
        pd.Series(
            [float("nan"), 4.0, 8.0, 6.0],
            index=["2024-01", "2024-02", "2025-01", "2025-02"],
            name=LEGUMES_LOWER,
        ),
    )


def test_load_diner_meal_data_rejects_periods_of_different_lengths(tmp_path: Path):
    baseline, _ = _write_pair(tmp_path)
    pilot = _write_qa_workbook(
        tmp_path / "short_pilot_qa.xlsx", [(PILOT_JAN, "Lentils", LEGUMES, 8)], {PILOT_JAN: 100}
    )

    with pytest.raises(AssertionError, match="baseline=2, pilot=1"):
        load_diner_meal_data(baseline, pilot)


def test_load_monthly_category_data_rejects_a_serving_report(tmp_path: Path):
    baseline, _ = _write_pair(tmp_path)
    pilot = _write_qa_workbook(
        tmp_path / "serving_qa.xlsx",
        [(PILOT_JAN, "Lentil Soup", LEGUMES, 8)],
        {PILOT_JAN: 100},
        serving=True,
    )

    with pytest.raises(ValueError, match="needs a procurement report"):
        load_monthly_category_data(baseline, pilot)
