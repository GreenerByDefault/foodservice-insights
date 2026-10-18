from typing import Any

import pandas as pd
import pytest
from gbd_foodservice_insights.report.food_report import FoodReport, build_food_report
from gbd_foodservice_insights.report.schema import Headcounts
from gbd_foodservice_insights_lab.food_report.summary import procurement_summary_stats

JAN, FEB = pd.period_range("2024-01", periods=2, freq="M")


def _report(
    categories: tuple[str, str] = ("Beef and Buffalo Meat", "Legumes"), **overrides: Any
) -> FoodReport:
    animal, plant = categories
    rows = pd.DataFrame(
        {
            "date": pd.to_datetime(["2024-01-15", "2024-01-20", "2024-02-15", "2024-02-20"]),
            "product": ["Ground Beef", "Lentils", "Ground Beef", "Lentils"],
            "category": [animal, plant, animal, plant],
            "kilos_total": [10.0, 20.0, 12.0, 18.0],
        }
    )
    kwargs: dict[str, Any] = {
        "headcounts": Headcounts("diner", {JAN: 100, FEB: 120}),
        "region": "us",
        "top_n_drivers": 5,
    }
    return build_food_report(rows, **(kwargs | overrides))


def test_procurement_summary_stats_print_the_reports_numbers():
    assert procurement_summary_stats(_report()) == {
        "Total rows": "4",
        "Unique products": "2",
        "Date range": "Jan 2024 – Feb 2024",
        "Total diners": "220",
        "Data type": "Procurement",
        "Region used for climate emissions factors": "US/Canada",
        "Total CO₂e": "970 kg",
        "CO₂e per diner": "4.411 kg",
        "Plant-based (% of classified food)": "63.3%",
        "Animal-based (% of classified food)": "36.7%",
        "Plant-based total": "38.0 kg",
        "Animal-based total": "22.0 kg",
        "Plant protein share (% of protein categories)": "63.3%",
        "Plant protein total": "38.0 kg",
        "Protein-category total": "60.0 kg",
    }


def test_procurement_summary_stats_leave_out_the_per_head_lines_without_headcounts():
    with_headcounts = procurement_summary_stats(_report())

    assert procurement_summary_stats(_report(headcounts=None)) == {
        label: value
        for label, value in with_headcounts.items()
        if label not in {"Total diners", "CO₂e per diner"}
    }


def test_procurement_summary_stats_leave_out_the_protein_lines_without_protein():
    stats = procurement_summary_stats(_report(("Cheese", "Oat Milk")))

    assert list(stats)[-1] == "Animal-based total"
    assert "Plant protein total" not in stats


@pytest.mark.parametrize(("region", "label"), [("us", "US/Canada"), ("europe", "EU/UK")])
def test_procurement_summary_stats_name_the_emissions_factor_region(region: str, label: str):
    stats = procurement_summary_stats(_report(region=region))

    assert stats["Region used for climate emissions factors"] == label
