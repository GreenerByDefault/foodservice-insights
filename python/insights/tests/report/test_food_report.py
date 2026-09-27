from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights import emissions
from gbd_foodservice_insights.report import aggregation
from gbd_foodservice_insights.report.food_report import (
    FoodReport,
    _attach_monthly_category_emissions,
    build_food_report,
    build_report_charts,
)
from gbd_foodservice_insights.report.plots import report as report_plots
from gbd_foodservice_insights.report.quality import QualityCheckError

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
    assert report.summary_stats == {
        "Total rows": "4",
        "Unique products": "2",
        "Date range": "Jan 2024 – Feb 2024",
        "Total diners": "220",
        "Data type": "Procurement",
        "Region used for climate emissions factors": "US/Canada",
        "Total CO2e": "970 kg",
        "CO2e per diner": "4.411 kg",
        "Plant-based (% of classified food)": "63.3%",
        "Animal-based (% of classified food)": "36.7%",
        "Plant-based total": "38.0 kg",
        "Animal-based total": "22.0 kg",
        "Plant protein share (% of protein categories)": "63.3%",
        "Plant protein total": "38.0 kg",
        "Protein-category total": "60.0 kg",
    }
    assert report.emissions_summary is not None
    assert report.procurement_table("animal_emissions_intensity") is not None


def test_an_error_finding_raises_with_every_finding_so_far():
    rows = _rows().assign(category=["Legumes", None, "Legumes", "Legumes"])

    with pytest.raises(QualityCheckError, match=r"\[ingestion::required_non_null\]") as excinfo:
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


def test_missing_date_column_aborts_at_ingestion():
    with pytest.raises(QualityCheckError, match=r"\[ingestion::required_columns\]") as excinfo:
        _build(_rows().drop(columns=["date"]))

    assert excinfo.value.findings == [
        {
            "stage": "ingestion",
            "category": "required_columns",
            "status": "error",
            "message": "Missing required columns: ['date']",
            "metadata": {"missing_columns": ["date"]},
        }
    ]


def test_unusable_diner_meal_mapping_aborts_immediately():
    with pytest.raises(QualityCheckError, match=r"\[ingestion::diner_meal_mapping\]") as excinfo:
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


def test_emissions_that_drop_a_row_abort_with_a_row_count_drift_finding(
    monkeypatch: pytest.MonkeyPatch,
):
    calculate_emissions = emissions.calculate_emissions

    def drop_last_row(df: pd.DataFrame, **kwargs: Any) -> Any:
        out, findings = calculate_emissions(df, **kwargs)
        return out.iloc[:-1], findings

    monkeypatch.setattr(emissions, "calculate_emissions", drop_last_row)

    with pytest.raises(QualityCheckError) as excinfo:
        _build(_rows())

    findings = excinfo.value.findings
    assert [f for f in findings if f["category"] == "row_count_drift"] == [
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


def test_emissions_calculation_exception_aborts(monkeypatch: pytest.MonkeyPatch):
    def boom(*args: Any, **kwargs: Any) -> Any:
        raise ValueError("emissions exploded")

    monkeypatch.setattr(emissions, "calculate_emissions", boom)

    with pytest.raises(
        QualityCheckError, match=r"\[emissions::emissions_calculation_failed\] emissions exploded"
    ):
        _build(_rows())


def test_unmatched_emission_factors_produce_category_and_month_findings():
    rows = _rows().assign(
        category=["Beef and Buffalo Meat", "Mystery", "Beef and Buffalo Meat", "Mystery"]
    )

    report = _build(rows)

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


def test_aggregation_failure_raises_from_the_original_exception(
    monkeypatch: pytest.MonkeyPatch,
):
    def boom(*args: Any, **kwargs: Any) -> Any:
        raise ValueError("aggregation exploded")

    monkeypatch.setattr(aggregation, "run_aggregation_pipeline", boom)

    with pytest.raises(QualityCheckError, match=r"\[aggregation::aggregation_failed\]") as excinfo:
        _build(_rows())

    assert str(excinfo.value.__cause__) == "aggregation exploded"


def test_a_category_bought_at_zero_weight_has_no_share_or_intensity():
    zero_pork = pd.DataFrame(
        {
            "date": ["2024-01-10"],
            "product": ["Pork Chop"],
            "category": ["Pork (pig meat)"],
            "kilos_total": [0.0],
        }
    )

    report = _build(pd.concat([_rows(), zero_pork], ignore_index=True))

    drivers = report.aggregation["category_drivers"]
    assert drivers[drivers["category"] == "Pork (pig meat)"].to_dict("records") == [
        {
            "category": "Pork (pig meat)",
            "product": "Pork Chop",
            "kilos_total": 0.0,
            "kilos_total_in_category": 0.0,
            "percentage": pytest.approx(np.nan, nan_ok=True),
        }
    ]
    intensity = report.aggregation["animal_emissions_intensity"]
    assert intensity[intensity["category"] == "Pork (pig meat)"].to_dict("records") == [
        {
            "category": "Pork (pig meat)",
            "kilos_total": 0.0,
            "total_kg_co2e": 0.0,
            "kg_co2e_per_kg_food": pytest.approx(np.nan, nan_ok=True),
        }
    ]


def test_a_data_month_missing_from_the_mapping_aborts():
    with pytest.raises(QualityCheckError) as excinfo:
        _build(_rows(), diner_meal_mapping={"2024-01": 100})

    assert excinfo.value.findings[-1] == {
        "stage": "aggregation",
        "category": "aggregation_failed",
        "status": "error",
        "message": (
            "Cannot compute per-diner metrics: missing months in diner_meal_mapping: "
            "[Period('2024-02', 'M')]"
        ),
    }


def test_a_mapping_month_absent_from_the_data_is_one_info_finding():
    report = _build(_rows(), diner_meal_mapping={"2024-01": 100, "2024-02": 120, "2024-03": 90})

    assert _findings(report, "date_alignment") == [
        {
            "stage": "diagnostics",
            "category": "date_alignment",
            "status": "info",
            "message": "Months in diner-meals but not in data: [Period('2024-03', 'M')]",
            "count": 1,
        }
    ]
    assert _findings(report, "diner_meal_alignment") == []


def test_a_category_bought_in_some_months_only_is_an_info_finding():
    lamb = pd.DataFrame(
        {
            "date": ["2024-01-10"],
            "product": ["Lamb Shoulder"],
            "category": ["Lamb/mutton & goat meat"],
            "kilos_total": [5.0],
        }
    )

    report = _build(pd.concat([_rows(), lamb], ignore_index=True))

    assert _findings(report, "missing_category_month_combos") == [
        {
            "stage": "diagnostics",
            "category": "missing_category_month_combos",
            "status": "info",
            "message": "Missing 1 category×month combinations.",
            "count": 1,
            "sample_values": ["Lamb/mutton and goat meat missing during Feb 2024"],
        }
    ]


def test_an_unfactored_category_files_no_new_missing_values():
    typo = pd.DataFrame(
        {
            "date": ["2024-01-10"],
            "product": ["Oat Milk"],
            "category": ["Mlik"],
            "kilos_total": [5.0],
        }
    )

    report = _build(pd.concat([_rows(), typo], ignore_index=True))

    assert _findings(report, "unmatched_emission_factors") == [
        {
            "stage": "emissions",
            "category": "unmatched_emission_factors",
            "status": "warning",
            "message": (
                "Some categories have no emission factor and produced missing emissions values."
            ),
            "count": 1,
            "sample_values": ["Mlik"],
        }
    ]
    assert _findings(report, "new_missing_values") == []


def test_serving_mode_computes_no_emissions():
    report = _build(_rows("servings total"), mode="serving", diner_or_meal="meal")

    assert report.metric_total == "servings total"
    assert report.emissions_summary is None
    assert "emissions_kg_co2e" not in report.rows.columns
    assert report.procurement_table("animal_emissions_intensity") is None
    assert report.summary_stats["Data type"] == "Serving"
    assert report.summary_stats["Total meals"] == "220"
    assert "Total CO2e" not in report.summary_stats


@pytest.mark.parametrize(("region", "label"), [("us", "US/Canada"), ("europe", "EU/UK")])
def test_summary_stats_names_the_emissions_factor_region(region, label):
    report = _build(_rows(), region=region)

    assert report.summary_stats["Region used for climate emissions factors"] == label


def test_summary_stats_prints_a_single_month_once():
    dates = ["2024-01-15", "2024-01-20", "2024-01-25", "2024-01-30"]
    report = _build(_rows().assign(date=dates), diner_meal_mapping={"2024-01": 100})

    assert report.summary_stats["Date range"] == "Jan 2024"


@pytest.mark.parametrize("region", ["us", "europe"])
def test_ambiguous_dates_abort_whatever_the_region(region):
    rows = _rows().assign(date=["01/01/2024", "01/01/2024", "01/02/2024", "01/02/2024"])

    with pytest.raises(QualityCheckError, match=r"\[date_normalization::date_parse_failure\]"):
        _build(rows, region=region)


# ----------------------------------------------------------------------
# Tests for build_report_charts
# ----------------------------------------------------------------------


def test_report_charts_stay_open_until_the_block_exits():
    before = set(plt.get_fignums())

    with build_report_charts(_build(_rows())) as charts:
        assert set(plt.get_fignums()) - before == {fig.number for _, fig in charts.figures}

    assert set(plt.get_fignums()) == before


def test_report_charts_close_when_the_block_raises():
    before = set(plt.get_fignums())

    with pytest.raises(RuntimeError, match="boom"), build_report_charts(_build(_rows())):
        raise RuntimeError("boom")

    assert set(plt.get_fignums()) == before


def test_report_charts_close_what_was_drawn_when_generation_raises(
    monkeypatch: pytest.MonkeyPatch,
):
    def generate_all_report_plots(**_kwargs: Any):
        plt.figure()
        raise RuntimeError("boom")

    monkeypatch.setattr(report_plots, "generate_all_report_plots", generate_all_report_plots)
    before = set(plt.get_fignums())

    with pytest.raises(RuntimeError, match="boom"), build_report_charts(_build(_rows())):
        pass

    assert set(plt.get_fignums()) == before
