from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights import emissions
from gbd_foodservice_insights.report import aggregation, checks, food_report
from gbd_foodservice_insights.report.food_report import (
    FoodReport,
    build_food_report,
    build_report_charts,
    date_range_label,
)
from gbd_foodservice_insights.report.plots import report as report_plots

JAN, FEB, MAR = pd.period_range("2024-01", periods=3, freq="M")


def _rows() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "date": pd.to_datetime(["2024-01-15", "2024-01-20", "2024-02-15", "2024-02-20"]),
            "product": ["Ground Beef", "Lentils", "Ground Beef", "Lentils"],
            "category": ["Beef and Buffalo Meat", "Legumes", "Beef and Buffalo Meat", "Legumes"],
            "kilos_total": [10.0, 20.0, 12.0, 18.0],
        }
    )


def _build(rows: pd.DataFrame, **overrides: Any) -> FoodReport:
    kwargs: dict[str, Any] = {
        "diner_meal_mapping": {JAN: 100, FEB: 120},
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
    assert report.region == "us"
    assert report.diner_meals_in_data == 220.0
    assert report.emissions_summary["total_kg_co2e"].sum() == pytest.approx(970.5)
    assert (report.plant_animal_split.plant_total, report.plant_animal_split.animal_total) == (
        38.0,
        22.0,
    )
    assert report.plant_protein_share is not None
    assert report.plant_protein_share.protein_total == 60.0
    assert report.aggregation.animal_emissions_intensity is not None


def test_rows_without_protein_have_no_plant_protein_share():
    rows = _rows().assign(category=["Cheese", "Oat Milk", "Cheese", "Oat Milk"])

    assert _build(rows).plant_protein_share is None


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


def test_a_category_outside_the_gbd_list_raises_even_if_only_its_case_differs():
    rows = _rows().assign(category=["Beef and Buffalo Meat", "legumes", "Mlik", "Legumes"])

    with pytest.raises(ValueError, match="Not GBD categories: Mlik, legumes"):
        _build(rows)


@pytest.mark.parametrize(
    ("mapping", "months"),
    [
        ({}, "2024-01, 2024-02"),
        ({JAN: 100}, "2024-02"),
        ({JAN: 100, FEB: 0}, "2024-02"),
        ({JAN: float("nan"), FEB: 120}, "2024-01"),
    ],
)
def test_a_data_month_without_a_positive_count_aborts(mapping: dict, months: str):
    with pytest.raises(ValueError, match=f"^No positive diner count for {months}$"):
        _build(_rows(), diner_meal_mapping=mapping)


@pytest.mark.parametrize(
    ("module", "stage"),
    [
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

    drivers = report.aggregation.category_drivers
    assert drivers[drivers["category"] == "Pork (pig meat)"].to_dict("records") == [
        {
            "category": "Pork (pig meat)",
            "product": "Pork Chop",
            "kilos_total": 0.0,
            "kilos_total_in_category": 0.0,
            "percentage": 0.0,
        }
    ]
    intensity = report.aggregation.animal_emissions_intensity
    assert intensity is not None
    assert intensity[intensity["category"] == "Pork (pig meat)"].to_dict("records") == [
        {
            "category": "Pork (pig meat)",
            "kilos_total": 0.0,
            "total_kg_co2e": 0.0,
            "kg_co2e_per_kg_food": pytest.approx(np.nan, nan_ok=True),
        }
    ]


def test_month_year_comes_from_date_even_when_the_rows_carry_one():
    report = _build(_rows().assign(month_year="1999-12"))

    assert report.rows["month_year"].tolist() == [JAN, JAN, FEB, FEB]


def test_a_mapping_month_absent_from_the_data_is_not_a_per_diner_denominator():
    aligned = _build(_rows())
    report = _build(_rows(), diner_meal_mapping={JAN: 100, FEB: 120, MAR: 0})

    assert report.diner_meals_in_data == 220.0
    pd.testing.assert_frame_equal(report.emissions_summary, aligned.emissions_summary)


@pytest.mark.parametrize("diner_or_meal", ["diner", "meal"])
def test_per_head_columns_are_named_for_the_counts_basis(diner_or_meal: str):
    report = _build(_rows(), diner_or_meal=diner_or_meal)

    per_head = f"kilos per {diner_or_meal}"
    assert list(report.aggregation.monthly_product.columns) == [
        "month_year",
        "product",
        "kilos_total",
        per_head,
    ]
    assert list(report.aggregation.monthly_category.columns) == [
        "month_year",
        "category",
        "kilos_total",
        per_head,
        "emissions_kg_co2e",
    ]
    assert list(report.emissions_summary.columns) == [
        "category",
        "total_kg_co2e",
        "pct_of_total",
        f"kg_co2e_per_{diner_or_meal}",
    ]


def test_date_range_label_prints_a_single_month_once():
    dates = pd.to_datetime(["2024-01-15", "2024-01-30"])

    assert date_range_label(pd.DataFrame({"date": dates})) == "Jan 2024"


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
        assert set(plt.get_fignums()) - before == {fig.number for fig in charts.figures}

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
