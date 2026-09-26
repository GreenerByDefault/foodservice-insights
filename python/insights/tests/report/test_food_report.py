from typing import Any

import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights import emissions
from gbd_foodservice_insights.report import aggregation
from gbd_foodservice_insights.report.food_report import (
    FoodReport,
    _attach_monthly_category_emissions,
    _build_empty_aggregation,
    build_food_report,
)
from gbd_foodservice_insights.report.quality import QualityPolicyError

JAN = pd.Period("2024-01", freq="M")
FEB = pd.Period("2024-02", freq="M")


# ----------------------------------------------------------------------
# Tests for _attach_monthly_category_emissions
# ----------------------------------------------------------------------


def test_attach_monthly_category_emissions_keeps_each_category_share():
    raw = pd.DataFrame(
        {
            "month_year": [JAN, JAN, JAN, JAN, FEB],
            "category": ["beef", "beef", "legumes", None, "beef"],
            "emissions_kg_co2e": [30.0, 10.0, 2.0, 1.0, 50.0],
        }
    )
    monthly_cat = pd.DataFrame(
        {
            "month_year": [JAN, JAN, JAN, FEB],
            "category": ["beef", "legumes", None, "beef"],
            "kilos_total": [4.0, 3.0, 1.0, 5.0],
        }
    )

    out = _attach_monthly_category_emissions(monthly_cat, raw)

    pd.testing.assert_frame_equal(
        out,
        monthly_cat.assign(emissions_kg_co2e=[40.0, 2.0, 1.0, 50.0]),
    )


def test_attach_monthly_category_emissions_leaves_unfactored_category_missing():
    raw = pd.DataFrame(
        {
            "month_year": [JAN, JAN],
            "category": ["beef", "mystery"],
            "emissions_kg_co2e": [30.0, np.nan],
        }
    )
    monthly_cat = pd.DataFrame(
        {
            "month_year": [JAN, JAN],
            "category": ["beef", "mystery"],
            "kilos_total": [4.0, 3.0],
        }
    )

    out = _attach_monthly_category_emissions(monthly_cat, raw)

    pd.testing.assert_frame_equal(
        out,
        monthly_cat.assign(emissions_kg_co2e=[30.0, np.nan]),
    )


def _rows(metric: str = "kilos_total") -> pd.DataFrame:
    return pd.DataFrame(
        {
            "date": ["2024-01-15", "2024-01-20", "2024-02-15", "2024-02-20"],
            "product": ["Ground Beef", "Lentils", "Ground Beef", "Lentils"],
            "category": ["Beef and Buffalo Meat", "Legumes", "Beef and Buffalo Meat", "Legumes"],
            metric: [10.0, 20.0, 12.0, 18.0],
        }
    )


def _build(rows: pd.DataFrame, **overrides: Any) -> FoodReport:
    kwargs: dict[str, Any] = {
        "diner_meal_mapping": {"2024-01": 100, "2024-02": 120},
        "mode": "procurement",
        "region": "us",
        "diner_or_meal": "diner",
        "top_n_drivers": 5,
    }
    return build_food_report(rows, **(kwargs | overrides))


def _findings(report: FoodReport, category: str) -> list[dict[str, Any]]:
    return [finding for finding in report.findings if finding["category"] == category]


# ----------------------------------------------------------------------
# Tests for build_food_report
# ----------------------------------------------------------------------


def test_build_food_report_leaves_the_callers_rows_alone():
    rows = _rows()

    report = _build(rows)

    pd.testing.assert_frame_equal(rows, _rows())
    assert "month_year" in report.rows.columns


def test_procurement_report_holds_its_normalized_inputs_and_tables():
    report = _build(_rows())

    assert report.rows["month_year"].tolist() == [JAN, JAN, FEB, FEB]
    assert report.diner_meal_mapping == {JAN: 100.0, FEB: 120.0}
    assert report.summary_stats["Data type"] == "Procurement"
    assert "Data Quality Status" not in report.summary_stats
    assert report.emissions_summary is not None
    assert report.procurement_table("animal_emissions_intensity") is not None


def test_hard_fail_raises_with_every_finding_so_far():
    rows = _rows().assign(category=["Legumes", None, "Legumes", "Legumes"])

    with pytest.raises(QualityPolicyError, match=r"\[ingestion::required_non_null\]") as excinfo:
        _build(rows)

    assert excinfo.value.findings == [
        {
            "stage": "ingestion",
            "category": "required_non_null",
            "status": "error",
            "message": "Column 'category' has 1 missing values in a required non-null field.",
            "column": "category",
            "count": 1,
            "metadata": {
                "sample_rows": [{"date": "2024-01-20", "product": "Lentils", "category": None}]
            },
        }
    ]


def test_missing_date_column_reports_required_column_and_normalization_findings():
    rows = _rows().drop(columns=["date"])

    report = _build(rows, missing_data_policy="warn_continue")

    assert _findings(report, "required_columns") == [
        {
            "stage": stage,
            "category": "required_columns",
            "status": "error",
            "message": "Missing required columns: ['date']",
            "metadata": {"missing_columns": ["date"]},
        }
        for stage in ("ingestion", "post_normalization", "diagnostics")
    ]
    assert _findings(report, "missing_date_column") == [
        {
            "stage": "date_normalization",
            "category": "missing_date_column",
            "status": "error",
            "message": "Column 'date' is missing and cannot be normalized.",
        }
    ]
    assert _findings(report, "month_year_generation_failed") == [
        {
            "stage": "month_normalization",
            "category": "month_year_generation_failed",
            "status": "error",
            "message": "Cannot create 'month_year' without 'date'. Both columns are missing.",
        }
    ]


def test_hard_fail_aborts_immediately_on_unusable_diner_meal_mapping():
    with pytest.raises(QualityPolicyError, match=r"\[ingestion::diner_meal_mapping\]") as excinfo:
        _build(_rows(), diner_meal_mapping={})

    assert excinfo.value.findings == [
        {
            "stage": "ingestion",
            "category": "diner_meal_mapping",
            "status": "error",
            "message": (
                "Could not load diner-meal mapping: Diner-meal mapping is empty after "
                "normalization."
            ),
        }
    ]


def test_emissions_that_drop_a_row_leave_a_row_count_drift_finding(
    monkeypatch: pytest.MonkeyPatch,
):
    calculate_emissions = emissions.calculate_emissions

    def drop_last_row(df: pd.DataFrame, **kwargs: Any) -> Any:
        out, findings = calculate_emissions(df, **kwargs)
        return out.iloc[:-1], findings

    monkeypatch.setattr(emissions, "calculate_emissions", drop_last_row)

    report = _build(_rows(), missing_data_policy="warn_continue")

    assert [f for f in _findings(report, "row_count_drift") if f["stage"] == "emissions"] == [
        {
            "stage": "emissions",
            "category": "row_count_drift",
            "status": "error",
            "message": (
                "Row count changed unexpectedly from 4 to 3 (delta: -1). This stage should "
                "preserve rows, so rows may have been lost silently."
            ),
            "count": 1,
            "metadata": {"before_rows": 4, "after_rows": 3, "delta": -1},
        }
    ]


def test_emissions_calculation_exception_produces_a_finding(monkeypatch: pytest.MonkeyPatch):
    def boom(*args: Any, **kwargs: Any) -> Any:
        raise ValueError("emissions exploded")

    monkeypatch.setattr(emissions, "calculate_emissions", boom)

    report = _build(_rows(), missing_data_policy="warn_continue")

    assert _findings(report, "emissions_calculation_failed") == [
        {
            "stage": "emissions",
            "category": "emissions_calculation_failed",
            "status": "error",
            "message": "emissions exploded",
        }
    ]
    assert report.emissions_summary is None
    assert "emissions_kg_co2e" not in report.rows.columns


def test_unmatched_emission_factors_produce_category_and_month_findings():
    rows = _rows().assign(
        category=["Beef and Buffalo Meat", "Mystery", "Beef and Buffalo Meat", "Mystery"]
    )

    report = _build(rows, missing_data_policy="warn_continue")

    assert _findings(report, "emissions_missing_by_category") == [
        {
            "stage": "emissions",
            "category": "emissions_missing_by_category",
            "status": "warning",
            "message": "2 rows have missing emissions values.",
            "column": "emissions_kg_co2e",
            "count": 2,
            "metadata": {"counts_by_category": {"Mystery": 2}},
        }
    ]
    assert _findings(report, "emissions_missing_by_month") == [
        {
            "stage": "emissions",
            "category": "emissions_missing_by_month",
            "status": "warning",
            "message": "Missing emissions occur in 2 months.",
            "column": "emissions_kg_co2e",
            "count": 2,
            "metadata": {"counts_by_month": {"2024-01": 1, "2024-02": 1}},
        }
    ]


def test_aggregation_failure_raises_under_hard_fail(monkeypatch: pytest.MonkeyPatch):
    def boom(*args: Any, **kwargs: Any) -> Any:
        raise ValueError("aggregation exploded")

    monkeypatch.setattr(aggregation, "run_aggregation_pipeline", boom)

    with pytest.raises(QualityPolicyError, match=r"\[aggregation::aggregation_failed\]"):
        _build(_rows())


def test_aggregation_failure_falls_back_to_empty_aggregation_under_warn_continue(
    monkeypatch: pytest.MonkeyPatch,
):
    def boom(*args: Any, **kwargs: Any) -> Any:
        raise ValueError("aggregation exploded")

    monkeypatch.setattr(aggregation, "run_aggregation_pipeline", boom)

    report = _build(_rows(), missing_data_policy="warn_continue")

    assert _findings(report, "aggregation_failed") == [
        {
            "stage": "aggregation",
            "category": "aggregation_failed",
            "status": "error",
            "message": "aggregation exploded",
        }
    ]
    for name, table in _build_empty_aggregation("kilos_total").items():
        pd.testing.assert_frame_equal(report.aggregation[name], table)


def test_months_missing_from_either_side_are_reported():
    report = _build(
        _rows(),
        diner_meal_mapping={"2024-01": 100, "2024-03": 90},
        missing_data_policy="warn_continue",
    )

    assert _findings(report, "diner_meal_alignment") == [
        {
            "stage": "ingestion",
            "category": "diner_meal_alignment",
            "status": "warning",
            "message": "Months in data but missing in diner-meal mapping: [Period('2024-02', 'M')]",
            "count": 1,
        },
        {
            "stage": "ingestion",
            "category": "diner_meal_alignment",
            "status": "info",
            "message": "Months in diner-meal mapping but absent in data: [Period('2024-03', 'M')]",
            "count": 1,
        },
    ]


def test_warn_continue_without_a_usable_mapping_builds_an_empty_aggregation():
    report = _build(_rows(), diner_meal_mapping={}, missing_data_policy="warn_continue")

    assert _findings(report, "diner_meal_mapping") == [
        {
            "stage": "ingestion",
            "category": "diner_meal_mapping",
            "status": "error",
            "message": (
                "Could not load diner-meal mapping: Diner-meal mapping is empty after "
                "normalization."
            ),
        }
    ]
    assert report.diner_meal_mapping == {}
    assert list(report.aggregation) == list(_build_empty_aggregation("kilos_total"))
    for name, table in _build_empty_aggregation("kilos_total").items():
        pd.testing.assert_frame_equal(report.aggregation[name], table)
    assert report.procurement_table("decision_kpis") is None


def test_serving_mode_computes_no_emissions():
    report = _build(_rows("servings total"), mode="serving", diner_or_meal="meal")

    assert report.metric_total == "servings total"
    assert report.emissions_summary is None
    assert "emissions_kg_co2e" not in report.rows.columns
    assert report.procurement_table("animal_emissions_intensity") is None
    assert report.summary_stats["Data type"] == "Serving"
    assert report.summary_stats["Total meals"] == "220"
    assert "Total CO2e" not in report.summary_stats


def test_summary_stats_falls_back_to_the_raw_region_code_for_uk():
    report = _build(_rows("servings total"), mode="serving", diner_or_meal="meal", region="uk")

    assert report.summary_stats["Region used for climate emissions factors"] == "UK"
