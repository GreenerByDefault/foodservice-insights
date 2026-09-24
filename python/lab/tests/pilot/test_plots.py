"""Tests for baseline-versus-pilot plotting support functions."""

import pandas as pd
from gbd_foodservice_insights_lab.pilot.plots import (
    print_baseline_pilot_percent_changes,
)


def test_print_baseline_pilot_percent_changes_returns_calculated_metrics(capsys):
    """The printed summary must also return the metrics promised by its public API."""
    monthly_category_data = pd.DataFrame(
        {
            "category": [
                "beef and buffalo meat",
                "beef and buffalo meat",
                "milk (cow's milk)",
                "milk (cow's milk)",
            ],
            "period": ["baseline", "pilot", "baseline", "pilot"],
            "kilos_total": [100.0, 80.0, 50.0, 25.0],
        }
    )
    diner_meal_data = pd.DataFrame(
        {
            "period": ["baseline", "pilot"],
            "diner-meals": [1_000, 1_000],
        }
    )

    metrics = print_baseline_pilot_percent_changes(
        monthly_category_data,
        diner_meal_data,
    )

    capsys.readouterr()
    assert isinstance(metrics, dict)
    assert metrics["total weight of food"]["baseline"] == 100.0
    assert metrics["total weight of food"]["pilot"] == 80.0
    assert metrics["total weight of food"]["pct_change"] == -20.0
    assert metrics["total weight of drink"]["pct_change"] == -50.0
