"""Tests for baseline-versus-pilot plotting support functions."""

import matplotlib.pyplot as plt
import pandas as pd
from gbd_foodservice_insights_lab.pilot.plots import (
    plot_metric_over_time,
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


class TestPlotMetricOverTime:
    def test_returns_figure(self):
        data = {
            "month_year": ["2023-01", "2023-02", "2023-03"],
            "category": ["fruit", "fruit", "fruit"],
            "kilos_total": [100, 150, 120],
        }
        df = pd.DataFrame(data)
        fig = plot_metric_over_time(df, metric="kilos_total")
        assert isinstance(fig, plt.Figure)
        plt.close(fig)

    def test_per_diner_meal(self):
        data = {
            "month_year": ["2023-01", "2023-02"],
            "category": ["fruit", "fruit"],
            "kilos_total": [100, 150],
        }
        df = pd.DataFrame(data)
        diner_meal_mapping = {"2023-01": 100, "2023-02": 120}
        fig = plot_metric_over_time(
            df, metric="kilos_total", per_diner_meal=True, diner_meal_mapping=diner_meal_mapping
        )
        assert isinstance(fig, plt.Figure)
        plt.close(fig)
