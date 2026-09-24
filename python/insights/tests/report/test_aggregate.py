import matplotlib
import numpy as np
import pandas as pd
import pytest

matplotlib.use("Agg")  # Use non-interactive backend for testing
from unittest.mock import patch

import matplotlib.pyplot as plt
from gbd_foodservice_insights.report import aggregation as aggregate
from gbd_foodservice_insights.report import diagnostics, plots


def _figure_title(fig: plt.Figure) -> str:
    """Return a figure-level title when present, otherwise its first panel title."""
    return fig.texts[0].get_text() if fig.texts else fig.axes[0].get_title()


# Sample Data for testing
@pytest.fixture
def sample_df():
    data = {
        "date": pd.to_datetime(["2023-01-01", "2023-01-15", "2023-02-01"]),
        "product": ["apple", "banana", "apple"],
        "kilos_total": [10, 20, 15],
        "category": ["fruit", "fruit", "fruit"],
        "month_year": ["2023-01", "2023-01", "2023-02"],
    }
    return pd.DataFrame(data)


def test_check_required_columns(sample_df):
    # This "True" assertion protects the happy path so validation is not overly strict.
    assert diagnostics.check_required_columns(sample_df) is True
    # This "False" assertion is the safety net that prevents downstream math on incomplete data.
    assert diagnostics.check_required_columns(sample_df.drop(columns=["kilos_total"])) is False


def test_baseline_pre_flight_checks(sample_df):
    diner_meal_mapping = {"2023-01": 100, "2023-02": 120}
    df = diagnostics.baseline_pre_flight_checks(sample_df.copy(), diner_meal_mapping)
    assert pd.api.types.is_datetime64_any_dtype(df["date"])

    with pytest.raises(AssertionError):
        df_with_neg = sample_df.copy()
        df_with_neg.loc[0, "kilos_total"] = -5
        diagnostics.baseline_pre_flight_checks(df_with_neg, diner_meal_mapping)


def test_aggregate_data(sample_df):
    diner_meal_mapping = {"2023-01": 100, "2023-02": 120}

    # Test aggregation by product
    agg_df = aggregate.aggregate_data(sample_df, group_by="product", timescale="month_year")
    assert "kilos_total" in agg_df.columns
    assert len(agg_df) == 3
    jan_apple = agg_df.loc[
        (agg_df["month_year"] == "2023-01") & (agg_df["product"] == "apple"),
        "kilos_total",
    ].iloc[0]
    assert jan_apple == 10

    # Test per diner-meal aggregation
    agg_per_diner_meal_df = aggregate.aggregate_data(
        sample_df,
        group_by="product",
        timescale="month_year",
        per_diner_meal=True,
        diner_meal_mapping=diner_meal_mapping,
    )
    assert "kilos per diner-meal" in agg_per_diner_meal_df.columns
    feb_apple_per_dm = agg_per_diner_meal_df.loc[
        (agg_per_diner_meal_df["month_year"] == "2023-02")
        & (agg_per_diner_meal_df["product"] == "apple"),
        "kilos per diner-meal",
    ].iloc[0]
    assert feb_apple_per_dm == pytest.approx(15 / 120)


@patch("gbd_foodservice_insights.report.aggregation.get_GBD_categories")
def test_create_template_data(mock_get_gbd_categories, sample_df):
    """Ensures report templates include missing categories with zero totals for stable chart
    tables.
    """
    mock_get_gbd_categories.return_value = ["fruit", "vegetable"]
    agg_df = aggregate.aggregate_data(sample_df, group_by="category", timescale="month_year")
    template_df = aggregate.create_template_data(agg_df, metric="kilos_total")
    assert "total" in template_df.columns
    assert "fruit" in template_df.index
    assert "vegetable" in template_df.index
    assert template_df.loc["vegetable", "total"] == 0


def test_identify_category_drivers(sample_df):
    drivers_df = aggregate.identify_category_drivers(sample_df, metric="kilos_total", top_n=1)
    assert "percentage" in drivers_df.columns
    assert len(drivers_df) == 1  # Only one category
    assert drivers_df["product"].iloc[0] == "apple"
    assert drivers_df["percentage"].iloc[0] == "55.6%"


def test_identify_overall_drivers(sample_df):
    drivers_df = aggregate.identify_overall_drivers(sample_df, metric="kilos_total", top_n=1)
    assert "percentage" in drivers_df.columns
    assert len(drivers_df) == 1
    assert drivers_df["product"].iloc[0] == "apple"
    assert drivers_df["percentage"].iloc[0] == "55.6%"


def test_category_highest_vs_lowest_months(sample_df):
    # Need more data for this test
    data = {
        "date": pd.to_datetime(["2023-01-01", "2023-02-01", "2023-03-01"]),
        "product": ["apple", "apple", "apple"],
        "kilos": [10, 40, 5],
        "category": ["fruit", "fruit", "fruit"],
        "month_year": ["2023-01", "2023-02", "2023-03"],
        "kilos per diner_meal": [0.1, 0.4, 0.05],
    }
    df = pd.DataFrame(data)
    ratio_df = aggregate.category_highest_vs_lowest_months(df, metric_col="kilos per diner_meal")
    assert len(ratio_df) == 1
    assert ratio_df["times_higher"].iloc[0] == 8.0


def test_summarize_animal_emissions_intensity():
    """Confirms procurement summaries include weight, total emissions, and intensity for animal
    categories only.
    """
    df = pd.DataFrame(
        {
            "category": [
                "Beef and Buffalo Meat",
                "Beef and Buffalo Meat",
                "Poultry (Chicken & Turkey)",
                "Legumes",
            ],
            "kilos_total": [2.0, 3.0, 4.0, 5.0],
            "emissions_kg_co2e": [82.7, 124.05, 17.6, 8.0],
        }
    )

    summary = aggregate.summarize_animal_emissions_intensity(df)

    assert summary["category"].tolist() == [
        "Beef and Buffalo Meat",
        "Poultry (Chicken & Turkey)",
    ]
    assert summary["kilos_total"].tolist() == [5.0, 4.0]
    assert summary["total_kg_co2e"].tolist() == [206.75, 17.6]
    assert summary["kg_co2e_per_kg_food"].tolist() == [41.35, 4.4]


def test_summarize_animal_emissions_intensity_normalizes_case_variants():
    df = pd.DataFrame(
        {
            "category": [
                "beef and buffalo meat",
                "Beef and Buffalo Meat",
                "POULTRY (CHICKEN & TURKEY)",
            ],
            "kilos_total": [2.0, 3.0, 4.0],
            "emissions_kg_co2e": [82.7, 124.05, 17.6],
        }
    )

    summary = aggregate.summarize_animal_emissions_intensity(df)

    assert summary["category"].tolist() == [
        "Beef and Buffalo Meat",
        "Poultry (Chicken & Turkey)",
    ]
    assert summary["kilos_total"].tolist() == [5.0, 4.0]
    assert summary["total_kg_co2e"].tolist() == [206.75, 17.6]


def test_category_highest_vs_lowest_months_returns_empty_frame_when_no_category_hits_threshold():
    """Keeps the aggregation pipeline usable when no category has a 2x month spread."""
    df = pd.DataFrame(
        {
            "category": ["legumes", "legumes"],
            "kilos per diner_meal": [0.1, 0.12],
        }
    )

    result = aggregate.category_highest_vs_lowest_months(df, metric_col="kilos per diner_meal")

    assert result.empty
    assert result.columns.tolist() == ["category", "times_higher"]


# ----------------------------------------------------------------------
# Tests for plotting functions
# ----------------------------------------------------------------------


class TestPlotDinerMealNumbers:
    """Tests for plot_diner_meal_numbers function."""

    def test_returns_figure(self):
        diner_meal_mapping = {"2023-01": 100, "2023-02": 120, "2023-03": 110}
        fig = plots.plot_diner_meal_numbers(diner_meal_mapping)
        assert isinstance(fig, plt.Figure)
        plt.close(fig)

    def test_accepts_series(self):
        diner_meal_series = pd.Series({"2023-01": 100, "2023-02": 120})
        fig = plots.plot_diner_meal_numbers(diner_meal_series)
        assert isinstance(fig, plt.Figure)
        plt.close(fig)


class TestPlotCategoryDrivers:
    """Tests for plot_category_drivers function."""

    def test_returns_dict_of_figures(self, sample_df):
        drivers_df = aggregate.identify_category_drivers(sample_df, metric="kilos_total", top_n=2)
        figs = plots.plot_category_drivers(drivers_df, metric="kilos_total")

        assert isinstance(figs, dict)
        for _category, fig in figs.items():
            assert isinstance(fig, plt.Figure)
            plt.close(fig)


class TestPlotOverallDrivers:
    """Tests for plot_overall_drivers function."""

    def test_returns_figure(self, sample_df):
        drivers_df = aggregate.identify_overall_drivers(sample_df, metric="kilos_total", top_n=2)
        fig = plots.plot_overall_drivers(drivers_df, metric="kilos_total")
        assert isinstance(fig, plt.Figure)
        plt.close(fig)


class TestPlotCategoryTotals:
    """Tests for plot_category_totals function."""

    def test_returns_figure(self, sample_df):
        agg_df = aggregate.aggregate_data(sample_df, group_by="category", timescale="month_year")
        fig = plots.plot_category_totals(agg_df, metric="kilos_total")
        assert isinstance(fig, plt.Figure)
        plt.close(fig)

    def test_duplicate_x_axis_label_is_removed(self):
        fig, ax = plt.subplots()
        ax.set_title("Carbon Emissions by Category")
        ax.set_xlabel("Carbon Emissions by Category")

        cleaned = plots._remove_duplicate_xlabels(fig)

        assert cleaned.axes[0].get_xlabel() == ""
        plt.close(cleaned)

    def test_safe_plot_marks_placeholder_figures_with_data_warning(self):
        """A fallback chart should still show a visible warning label in the PDF itself."""
        findings = []

        caption, fig = plots._safe_plot(
            caption="Carbon Emissions by Category",
            plot_fn=lambda: (_ for _ in ()).throw(ValueError("boom")),
            quality_findings=findings,
            warning_message="Could not plot emissions by category",
        )

        assert caption == "Carbon Emissions by Category [DATA WARNING]"
        assert _figure_title(fig) == "Carbon Emissions by Category [DATA WARNING]"
        assert findings[-1]["category"] == "plot_generation"
        plt.close(fig)


class TestPlotMetricOverTime:
    """Tests for plot_metric_over_time function."""

    def test_returns_figure(self):
        data = {
            "month_year": ["2023-01", "2023-02", "2023-03"],
            "category": ["fruit", "fruit", "fruit"],
            "kilos_total": [100, 150, 120],
        }
        df = pd.DataFrame(data)
        fig = plots.plot_metric_over_time(df, metric="kilos_total")
        assert isinstance(fig, plt.Figure)
        plt.close(fig)

    @patch("gbd_foodservice_insights.report.plots.get_food_categories")
    @patch("gbd_foodservice_insights.report.plots.get_drink_categories")
    def test_food_vs_food_and_drink_split(
        self, mock_get_drink_categories, mock_get_food_categories
    ):
        mock_get_food_categories.return_value = ["fruit"]
        mock_get_drink_categories.return_value = ["juice"]

        df = pd.DataFrame(
            {
                "month_year": ["2023-01", "2023-01", "2023-02", "2023-02"],
                "category": ["fruit", "juice", "fruit", "juice"],
                "kilos_total": [100, 25, 150, 40],
            }
        )

        fig = plots.plot_food_vs_food_and_drink_over_time(df, metric="kilos_total")

        assert isinstance(fig, plt.Figure)
        assert len(fig.axes) == 2
        assert fig.axes[0].get_title() == "Food Only"
        assert fig.axes[1].get_title() == "Food + Drink"
        assert np.asarray(fig.axes[0].lines[0].get_ydata()).tolist() == [100, 150]
        assert np.asarray(fig.axes[1].lines[0].get_ydata()).tolist() == [125, 190]
        plt.close(fig)

    @patch("gbd_foodservice_insights.report.plots.get_food_categories")
    @patch("gbd_foodservice_insights.report.plots.get_drink_categories")
    def test_food_and_drink_comparison_page_uses_two_lines_on_each_chart(
        self,
        mock_get_drink_categories,
        mock_get_food_categories,
    ):
        mock_get_food_categories.return_value = ["fruit"]
        mock_get_drink_categories.return_value = ["juice"]

        df = pd.DataFrame(
            {
                "month_year": ["2023-01", "2023-01", "2023-02", "2023-02"],
                "category": ["fruit", "juice", "fruit", "juice"],
                "kilos_total": [100, 25, 150, 40],
            }
        )

        fig = plots.plot_food_and_drink_comparison_page(
            df,
            metric="kilos_total",
            diner_meal_mapping={"2023-01": 100, "2023-02": 100},
        )

        assert isinstance(fig, plt.Figure)
        assert len(fig.axes) == 2
        assert _figure_title(fig) == "Kilos Over Time"
        assert fig.axes[0].get_title() == "Total Kilos"
        assert fig.axes[1].get_title() == "Kilos per Diner"
        assert len(fig.axes[0].lines) == 2
        assert len(fig.axes[1].lines) == 2
        assert np.asarray(fig.axes[0].lines[0].get_ydata()).tolist() == [100, 150]
        assert np.asarray(fig.axes[0].lines[1].get_ydata()).tolist() == [125, 190]
        assert np.asarray(fig.axes[1].lines[0].get_ydata()).tolist() == [1.0, 1.5]
        assert np.asarray(fig.axes[1].lines[1].get_ydata()).tolist() == [1.25, 1.9]
        plt.close(fig)

    @patch("gbd_foodservice_insights.report.plots.get_food_categories")
    @patch("gbd_foodservice_insights.report.plots.get_drink_categories")
    def test_food_vs_food_and_drink_over_time_raises_for_untyped_categories(
        self,
        mock_get_drink_categories,
        mock_get_food_categories,
    ):
        """Unexpected category labels should fail loudly instead of silently disappearing."""
        mock_get_food_categories.return_value = ["fruit"]
        mock_get_drink_categories.return_value = ["juice"]

        df = pd.DataFrame(
            {
                "month_year": ["2023-01", "2023-01"],
                "category": ["fruit", "No Matches Found"],
                "kilos_total": [100, 25],
            }
        )

        with pytest.raises(ValueError, match="Unknown categories"):
            plots.plot_food_vs_food_and_drink_over_time(df, metric="kilos_total")

    @patch("gbd_foodservice_insights.report.plots.get_food_categories")
    @patch("gbd_foodservice_insights.report.plots.get_drink_categories")
    def test_generate_all_report_plots_uses_combined_trend_charts(
        self,
        mock_get_drink_categories,
        mock_get_food_categories,
    ):
        mock_get_food_categories.return_value = ["fruit"]
        mock_get_drink_categories.return_value = ["juice"]

        monthly_category_data = pd.DataFrame(
            {
                "month_year": ["2023-01", "2023-01", "2023-02", "2023-02"],
                "category": ["fruit", "juice", "fruit", "juice"],
                "kilos_total": [100, 25, 150, 40],
            }
        )

        plots_output = plots.generate_all_report_plots(
            aggregated_data={
                "monthly_category_data": monthly_category_data,
                "overall_drivers": pd.DataFrame(
                    {"product": ["apple"], "percentage": ["100.0%"], "kilos_total": [250]}
                ),
                "category_drivers": pd.DataFrame(
                    {
                        "category": ["fruit"],
                        "product": ["apple"],
                        "percentage": ["100.0%"],
                        "kilos_total": [250],
                    }
                ),
            },
            diner_meal_mapping={"2023-01": 100, "2023-02": 100},
            metric_total="kilos_total",
        )

        assert all(caption == "" for caption, _ in plots_output)

        combined_trend_fig = plots_output[1][1]

        assert _figure_title(combined_trend_fig) == "Kilos Over Time"
        assert combined_trend_fig.axes[0].get_title() == "Total Kilos"
        assert combined_trend_fig.axes[1].get_title() == "Kilos per Diner"
        assert len(combined_trend_fig.axes[0].lines) == 2
        assert len(combined_trend_fig.axes[1].lines) == 2
        for _, fig in plots_output:
            plt.close(fig)

    @patch("gbd_foodservice_insights.report.plots.get_food_categories")
    @patch("gbd_foodservice_insights.report.plots.get_drink_categories")
    def test_generate_all_report_plots_raises_for_untyped_categories(
        self,
        mock_get_drink_categories,
        mock_get_food_categories,
    ):
        mock_get_food_categories.return_value = ["fruit"]
        mock_get_drink_categories.return_value = ["juice"]

        monthly_category_data = pd.DataFrame(
            {
                "month_year": ["2023-01", "2023-01"],
                "category": ["fruit", "No Matches Found"],
                "kilos_total": [100, 25],
            }
        )

        with pytest.raises(ValueError, match="Unknown categories"):
            plots.generate_all_report_plots(
                aggregated_data={
                    "monthly_category_data": monthly_category_data,
                    "overall_drivers": pd.DataFrame(
                        {"product": ["apple"], "percentage": ["100.0%"], "kilos_total": [100]}
                    ),
                    "category_drivers": pd.DataFrame(
                        {
                            "category": ["fruit"],
                            "product": ["apple"],
                            "percentage": ["100.0%"],
                            "kilos_total": [100],
                        }
                    ),
                },
                diner_meal_mapping={"2023-01": 100},
                metric_total="kilos_total",
            )

    @patch("gbd_foodservice_insights.report.plots.get_food_categories")
    @patch("gbd_foodservice_insights.report.plots.get_drink_categories")
    def test_generate_all_report_plots_places_category_totals_before_carbon_pages(
        self,
        mock_get_drink_categories,
        mock_get_food_categories,
    ):
        mock_get_food_categories.return_value = ["fruit"]
        mock_get_drink_categories.return_value = ["juice"]

        monthly_category_data = pd.DataFrame(
            {
                "month_year": ["2023-01", "2023-01", "2023-02", "2023-02"],
                "category": ["fruit", "juice", "fruit", "juice"],
                "kilos_total": [100, 25, 150, 40],
                "emissions_kg_co2e": [30, 5, 45, 8],
            }
        )
        emissions_summary = pd.DataFrame(
            {
                "category": ["fruit", "juice"],
                "total_kg_co2e": [75, 13],
            }
        )

        plots_output = plots.generate_all_report_plots(
            aggregated_data={
                "monthly_category_data": monthly_category_data,
                "overall_drivers": pd.DataFrame(
                    {"product": ["apple"], "percentage": ["100.0%"], "kilos_total": [250]}
                ),
                "category_drivers": pd.DataFrame(
                    {
                        "category": ["fruit"],
                        "product": ["apple"],
                        "percentage": ["100.0%"],
                        "kilos_total": [250],
                    }
                ),
            },
            diner_meal_mapping={"2023-01": 100, "2023-02": 100},
            emissions_summary=emissions_summary,
            metric_total="kilos_total",
        )

        page_titles = [_figure_title(fig) for _, fig in plots_output]

        assert page_titles.index("Kilos by Category Across All Months") < page_titles.index(
            "Carbon Emissions by Category"
        )
        for _, fig in plots_output:
            plt.close(fig)

    @patch("gbd_foodservice_insights.report.plots.get_food_categories")
    @patch("gbd_foodservice_insights.report.plots.get_drink_categories")
    def test_generate_all_report_plots_combines_emissions_trends_onto_one_page(
        self,
        mock_get_drink_categories,
        mock_get_food_categories,
    ):
        mock_get_food_categories.return_value = ["fruit"]
        mock_get_drink_categories.return_value = ["juice"]

        monthly_category_data = pd.DataFrame(
            {
                "month_year": ["2023-01", "2023-01", "2023-02", "2023-02"],
                "category": ["fruit", "juice", "fruit", "juice"],
                "kilos_total": [100, 25, 150, 40],
                "emissions_kg_co2e": [30, 5, 45, 8],
            }
        )
        emissions_summary = pd.DataFrame(
            {
                "category": ["fruit", "juice"],
                "total_kg_co2e": [75, 13],
            }
        )

        plots_output = plots.generate_all_report_plots(
            aggregated_data={
                "monthly_category_data": monthly_category_data,
                "overall_drivers": pd.DataFrame(
                    {"product": ["apple"], "percentage": ["100.0%"], "kilos_total": [250]}
                ),
                "category_drivers": pd.DataFrame(
                    {
                        "category": ["fruit"],
                        "product": ["apple"],
                        "percentage": ["100.0%"],
                        "kilos_total": [250],
                    }
                ),
            },
            diner_meal_mapping={"2023-01": 100, "2023-02": 100},
            emissions_summary=emissions_summary,
            metric_total="kilos_total",
        )

        assert all(caption == "" for caption, _ in plots_output)

        matching_figs = [
            fig for _, fig in plots_output if _figure_title(fig) == "Carbon Emissions Over Time"
        ]

        assert len(matching_figs) == 1
        combined_fig = matching_figs[0]
        assert len(combined_fig.axes) == 2
        assert combined_fig.axes[0].get_title() == "Total Carbon Emissions Over Time"
        assert combined_fig.axes[1].get_title() == "Carbon Emissions per Diner Over Time"
        first_pos = combined_fig.axes[0].get_position()
        second_pos = combined_fig.axes[1].get_position()
        assert first_pos.x0 < second_pos.x0
        assert abs(first_pos.y0 - second_pos.y0) < 0.05

        for _, fig in plots_output:
            plt.close(fig)

    def test_generate_all_report_plots_combines_plant_share_panels_onto_one_page(self):
        monthly_category_data = pd.DataFrame(
            {
                "month_year": ["2023-01", "2023-02"],
                "category": ["legumes", "legumes"],
                "kilos_total": [100, 120],
            }
        )

        plots_output = plots.generate_all_report_plots(
            aggregated_data={
                "monthly_category_data": monthly_category_data,
                "overall_drivers": pd.DataFrame(
                    {"product": ["beans"], "percentage": ["100.0%"], "kilos_total": [220]}
                ),
                "category_drivers": pd.DataFrame(
                    {
                        "category": ["legumes"],
                        "product": ["beans"],
                        "percentage": ["100.0%"],
                        "kilos_total": [220],
                    }
                ),
            },
            diner_meal_mapping={"2023-01": 100, "2023-02": 100},
            metric_total="kilos_total",
            plant_animal_split={
                "plant_pct": 52.0,
                "animal_pct": 48.0,
                "plant_kg": 114.4,
                "animal_kg": 105.6,
                "monthly": pd.DataFrame(
                    {
                        "month_year": ["2023-01", "2023-02"],
                        "plant": [48.0, 66.4],
                        "animal": [52.0, 53.6],
                        "plant_pct": [48.0, 55.3],
                    }
                ),
            },
            plant_protein_share={
                "plant_protein_pct": 55.0,
                "plant_protein_total": 121.0,
                "total_protein_metric": 220.0,
                "monthly": pd.DataFrame(
                    {
                        "month_year": ["2023-01", "2023-02"],
                        "plant_protein_metric": [50.0, 71.0],
                        "total_protein_metric": [100.0, 120.0],
                        "plant_protein_pct": [50.0, 59.2],
                    }
                ),
            },
        )

        assert all(caption == "" for caption, _ in plots_output)

        matching_figs = [
            fig for _, fig in plots_output if _figure_title(fig) == "Plant and Protein Breakdown"
        ]

        assert len(matching_figs) == 1
        combined_fig = matching_figs[0]
        assert len(combined_fig.axes) == 4
        panel_titles = [ax.get_title() for ax in combined_fig.axes]
        assert "Plant vs. Animal Split" in panel_titles
        assert "Plant-Based % by Month" in panel_titles
        assert "Plant Protein Share" in panel_titles
        assert "Plant Protein % by Month" in panel_titles

        for _, fig in plots_output:
            plt.close(fig)

    def test_per_diner_meal(self):
        data = {
            "month_year": ["2023-01", "2023-02"],
            "category": ["fruit", "fruit"],
            "kilos_total": [100, 150],
        }
        df = pd.DataFrame(data)
        diner_meal_mapping = {"2023-01": 100, "2023-02": 120}
        fig = plots.plot_metric_over_time(
            df, metric="kilos_total", per_diner_meal=True, diner_meal_mapping=diner_meal_mapping
        )
        assert isinstance(fig, plt.Figure)
        plt.close(fig)


class TestProfileDatePlots:
    """Tests for date-profile helper plots used in validation-style workflows."""

    def test_plot_date_value_counts_returns_figure_with_expected_labels(self):
        df = pd.DataFrame(
            {
                "date": ["2024-01-01", "2024-01-01", "2024-01-02"],
            }
        )

        fig = plots.plot_date_value_counts(df)

        assert isinstance(fig, plt.Figure)
        assert len(fig.axes) == 1
        assert fig.axes[0].get_title() == "Date Value Counts"
        assert fig.axes[0].get_xlabel() == "Date"
        assert fig.axes[0].get_ylabel() == "Counts"
        plt.close(fig)

    def test_plot_date_value_counts_returns_placeholder_when_date_column_missing(self):
        fig = plots.plot_date_value_counts(pd.DataFrame({"weight": [1.0, 2.0]}))

        assert isinstance(fig, plt.Figure)
        assert len(fig.axes) == 1
        assert fig.axes[0].texts[0].get_text() == "Date Value Counts"
        assert fig.axes[0].texts[1].get_text() == "Missing 'date' column."
        plt.close(fig)

    def test_plot_metric_by_date_returns_three_panel_figure(self):
        """Metric-by-date should build the three summary panels rather than silently omitting
        one.
        """
        df = pd.DataFrame(
            {
                "date": ["2024-01-01", "2024-01-01", "2024-01-02"],
                "kilos_total": [10.0, 14.0, 6.0],
            }
        )

        fig = plots.plot_metric_by_date(df, "kilos_total")

        assert isinstance(fig, plt.Figure)
        assert len(fig.axes) == 3
        assert [ax.get_title() for ax in fig.axes] == [
            "Mean kilos_total by date",
            "Median kilos_total by date",
            "Sum kilos_total by date",
        ]
        plt.close(fig)

    def test_plot_metric_by_date_raises_when_metric_column_missing(self):
        """Missing metric columns should fail clearly instead of returning an empty-looking
        chart.
        """
        df = pd.DataFrame({"date": ["2024-01-01", "2024-01-02"]})

        with pytest.raises(KeyError, match="kilos_total"):
            plots.plot_metric_by_date(df, "kilos_total")


class TestCheckZeroCategoryMonthCombos:
    """Tests for check_zero_category_month_combos function."""

    def test_returns_missing_combo_findings(self):
        data = {
            "month_year": ["2023-01", "2023-02"],
            "category": ["fruit", "vegetable"],
            "kilos_total": [100, 50],
        }
        df = pd.DataFrame(data)
        findings = diagnostics.check_zero_category_month_combos(df, "kilos_total")
        assert isinstance(findings, list)
        assert any(f["category"] == "missing_category_month_combos" for f in findings)

    def test_missing_combo_samples_use_plain_english(self):
        df = pd.DataFrame(
            {
                "month_year": ["2024-01", "2024-02", "2024-01"],
                "category": ["Lamb/mutton & goat meat", "Legumes", "Legumes"],
                "kilos_total": [10, 5, 7],
            }
        )

        findings = diagnostics.check_zero_category_month_combos(df, "kilos_total")
        missing_finding = next(
            f for f in findings if f["category"] == "missing_category_month_combos"
        )

        assert (
            "Lamb/mutton and goat meat missing during Feb 2024" in missing_finding["sample_values"]
        )


class TestIdentifyPotentiallyAbnormalWeightMeatItems:
    """Tests for identify_potentially_abnormal_weight_meat_items function."""

    def test_identifies_abnormal_meat_quantities(self):
        data = {
            "product": ["beef steak", "pork chop", "tofu", "beef stew"],
            "quantity": [5, 50, 10, 2.5],  # 50 is > 30, 2.5 has decimal
            # Use actual GBD category names
            "category": [
                "beef and buffalo meat",
                "pork (pig meat)",
                "legumes",
                "beef and buffalo meat",
            ],
        }
        df = pd.DataFrame(data)
        result = diagnostics.identify_potentially_abnormal_weight_meat_items(df)
        assert isinstance(result, pd.DataFrame)
        assert sorted(result["product"].tolist()) == ["beef stew", "pork chop"]


# ----------------------------------------------------------------------
# Fixture cleanup
# ----------------------------------------------------------------------


@pytest.fixture(autouse=True)
def cleanup_plt():
    """Clean up matplotlib figures after each test."""
    yield
    plt.close("all")
