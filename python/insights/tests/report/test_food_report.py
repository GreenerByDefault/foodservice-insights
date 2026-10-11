from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights import emissions
from gbd_foodservice_insights.report import aggregation, checks, food_report
from gbd_foodservice_insights.report.food_report import (
    FoodReport,
    _attach_monthly_category_emissions,
    build_food_report,
    build_report_charts,
)
from gbd_foodservice_insights.report.plots import report as report_plots

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


def _rows(metric: str = "kilos_total") -> pd.DataFrame:
    return pd.DataFrame(
        {
            "date": pd.to_datetime(["2024-01-15", "2024-01-20", "2024-02-15", "2024-02-20"]),
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


def test_a_missing_required_column_raises():
    with pytest.raises(ValueError, match="Missing required columns: date"):
        _build(_rows().drop(columns=["date"]))


def test_a_null_product_raises():
    rows = _rows().assign(product=["Ground Beef", None, "Ground Beef", "Lentils"])

    with pytest.raises(ValueError, match="product is missing in 1 of 4 rows"):
        _build(rows)


def test_a_negative_metric_raises():
    rows = _rows().assign(kilos_total=[10.0, -1.0, 12.0, 18.0])

    with pytest.raises(ValueError, match="kilos_total is negative in 1 of 4 rows"):
        _build(rows)


@pytest.mark.parametrize(
    ("mode", "metric", "diner_or_meal"),
    [("procurement", "kilos_total", "diner"), ("serving", "servings total", "meal")],
)
def test_a_category_outside_the_gbd_list_raises_even_if_only_its_case_differs(
    mode: str, metric: str, diner_or_meal: str
):
    rows = _rows(metric).assign(category=["Beef and Buffalo Meat", "legumes", "Mlik", "Legumes"])

    with pytest.raises(ValueError, match="Not GBD categories: Mlik, legumes"):
        _build(rows, mode=mode, diner_or_meal=diner_or_meal)


def test_an_empty_diner_meal_mapping_raises():
    with pytest.raises(ValueError, match="Diner-meal mapping is empty"):
        _build(_rows(), diner_meal_mapping={})


@pytest.mark.parametrize(
    ("module", "stage"),
    [
        (food_report, "ensure_month_year_column"),
        (emissions, "calculate_emissions"),
        (aggregation, "run_aggregation_pipeline"),
        (emissions, "calculate_emissions_summary"),
        (food_report, "calculate_plant_animal_split"),
        (food_report, "calculate_plant_protein_share"),
        (checks, "run_all_diagnostics"),
    ],
)
def test_a_stage_that_raises_surfaces_its_own_exception(
    monkeypatch: pytest.MonkeyPatch, module: Any, stage: str
):
    class StageExplodedError(Exception):
        pass

    def boom(*args: Any, **kwargs: Any) -> Any:
        raise StageExplodedError(stage)

    monkeypatch.setattr(module, stage, boom)

    with pytest.raises(StageExplodedError, match=stage):
        _build(_rows())


def test_a_category_bought_at_zero_weight_has_0_percent_drivers_and_no_intensity():
    zero_pork = pd.DataFrame(
        {
            "date": pd.to_datetime(["2024-01-10"]),
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
            "percentage": 0.0,
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
    with pytest.raises(
        ValueError, match=r"missing months in diner_meal_mapping: \[Period\('2024-02'"
    ):
        _build(_rows(), diner_meal_mapping={"2024-01": 100})


def test_a_mapping_month_absent_from_the_data_is_not_a_per_diner_denominator():
    aligned = _build(_rows())
    report = _build(_rows(), diner_meal_mapping={"2024-01": 100, "2024-02": 120, "2024-03": 90})

    assert report.diner_meals_in_data == 220.0
    assert report.summary_stats == aligned.summary_stats
    assert report.emissions_summary is not None and aligned.emissions_summary is not None
    pd.testing.assert_frame_equal(report.emissions_summary, aligned.emissions_summary)


@pytest.mark.parametrize("diner_or_meal", ["diner", "meal"])
def test_per_head_columns_are_named_for_the_counts_basis(diner_or_meal: str):
    report = _build(_rows(), diner_or_meal=diner_or_meal)

    per_head = f"kilos per {diner_or_meal}"
    assert list(report.aggregation["monthly_product_data"].columns) == [
        "month_year",
        "product",
        "kilos_total",
        per_head,
    ]
    assert list(report.aggregation["monthly_category_data"].columns) == [
        "month_year",
        "category",
        "kilos_total",
        per_head,
        "emissions_kg_co2e",
    ]
    assert report.emissions_summary is not None
    assert list(report.emissions_summary.columns) == [
        "category",
        "total_kg_co2e",
        "pct_of_total",
        f"kg_co2e_per_{diner_or_meal}",
    ]


def test_serving_per_head_columns_drop_the_servings_total_suffix():
    report = _build(_rows("servings total"), mode="serving", diner_or_meal="meal")

    assert list(report.aggregation["monthly_product_data"].columns) == [
        "month_year",
        "product",
        "servings total",
        "servings per meal",
    ]


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
    dates = pd.to_datetime(["2024-01-15", "2024-01-20", "2024-01-25", "2024-01-30"])
    report = _build(_rows().assign(date=dates), diner_meal_mapping={"2024-01": 100})

    assert report.summary_stats["Date range"] == "Jan 2024"


def test_a_text_date_raises_type_error():
    rows = _rows().assign(date=["2024-01-15", "2024-01-20", "2024-02-15", "2024-02-20"])

    with pytest.raises(TypeError, match="date must be datetime64"):
        _build(rows)


def test_a_text_metric_raises_type_error():
    rows = _rows().assign(kilos_total=["10", "20", "12", "18"])

    with pytest.raises(TypeError, match="kilos_total must be numeric"):
        _build(rows)


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


def test_a_chart_that_raises_fails_the_report_and_closes_what_was_drawn(
    monkeypatch: pytest.MonkeyPatch,
):
    # The last chart drawn, so every page before it is open when it raises.
    def plot_category_drivers_pages(*_args: Any, **_kwargs: Any):
        plt.figure()
        raise RuntimeError("boom")

    monkeypatch.setattr(report_plots, "plot_category_drivers_pages", plot_category_drivers_pages)
    before = set(plt.get_fignums())

    with pytest.raises(RuntimeError, match="boom"), build_report_charts(_build(_rows())):
        pass

    assert set(plt.get_fignums()) == before
