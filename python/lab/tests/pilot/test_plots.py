"""Tests for baseline-versus-pilot plotting support functions."""

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights.report.metric import KILOS, SERVINGS
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
    def test_plots_and_labels_the_metrics_column(self):
        data = {
            "month_year": [pd.Period("2023-01"), pd.Period("2023-02"), pd.Period("2023-03")],
            "category": ["fruit", "fruit", "fruit"],
            "servings total": [100, 150, 120],
        }
        df = pd.DataFrame(data)
        fig = plot_metric_over_time(df, metric=SERVINGS)
        (ax,) = fig.axes
        assert (ax.get_title(), ax.get_ylabel()) == ("Total Servings Over Time", "Total Servings")
        assert np.asarray(ax.lines[0].get_ydata()).tolist() == [100, 150, 120]
        plt.close(fig)

    @pytest.mark.parametrize(
        "months",
        [
            [pd.Period("2023-01"), pd.Period("2023-02")],
            ["2023-01", "2023-02"],
            [pd.Timestamp("2023-01-01"), pd.Timestamp("2023-02-01")],
        ],
        ids=["period", "string", "timestamp"],
    )
    def test_per_diner_meal(self, months: list):
        data = {
            "month_year": months,
            "category": ["fruit", "fruit"],
            "kilos_total": [100, 150],
        }
        df = pd.DataFrame(data)
        diner_meal_mapping = {"2023-01": 100, "2023-02": 120}
        fig = plot_metric_over_time(
            df, metric=KILOS, per_diner_meal=True, diner_meal_mapping=diner_meal_mapping
        )
        assert np.asarray(fig.axes[0].lines[0].get_ydata()).tolist() == pytest.approx([1.0, 1.25])
        plt.close(fig)
