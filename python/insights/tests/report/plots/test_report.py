from collections.abc import Callable
from typing import Any

import matplotlib.pyplot as plt
import pandas as pd
import pytest
from gbd_foodservice_insights.report.plots import panels, report
from matplotlib.figure import Figure


def _figure_title(fig: Figure) -> str:
    """Return a figure-level title when present, otherwise its first panel title."""
    return fig.texts[0].get_text() if fig.texts else fig.axes[0].get_title()


def _aggregated_data(
    monthly_category_data: pd.DataFrame, *, product: str, category: str, total: float
) -> dict[str, pd.DataFrame]:
    """Aggregates where one product drives everything, for tests that only vary the months."""
    return {
        "monthly_category_data": monthly_category_data,
        "overall_drivers": pd.DataFrame(
            {"product": [product], "percentage": ["100.0%"], "kilos_total": [total]}
        ),
        "category_drivers": pd.DataFrame(
            {
                "category": [category],
                "product": [product],
                "percentage": ["100.0%"],
                "kilos_total": [total],
            }
        ),
    }


def test_remove_duplicate_xlabels_clears_an_x_label_that_repeats_the_title():
    fig, ax = plt.subplots()
    ax.set_title("Carbon Emissions by Category")
    ax.set_xlabel("Carbon Emissions by Category")

    cleaned = report._remove_duplicate_xlabels(fig)

    assert cleaned.axes[0].get_xlabel() == ""


def test_safe_plot_marks_placeholder_figures_with_data_warning():
    """A fallback chart should still show a visible warning label in the PDF itself."""
    findings = []

    caption, fig = report._safe_plot(
        caption="Carbon Emissions by Category",
        plot_fn=lambda: (_ for _ in ()).throw(ValueError("boom")),
        quality_findings=findings,
        warning_message="Could not plot emissions by category",
    )

    assert caption == "Carbon Emissions by Category [DATA WARNING]"
    assert _figure_title(fig) == "Carbon Emissions by Category [DATA WARNING]"
    assert findings[-1]["category"] == "plot_generation"


def test_safe_plot_closes_the_figure_a_failed_plot_opened():
    before = set(plt.get_fignums())

    def plot_fn():
        plt.figure()
        raise ValueError("boom")

    _caption, fig = report._safe_plot(
        caption="Carbon Emissions by Category",
        plot_fn=plot_fn,
        quality_findings=[],
        warning_message="Could not plot emissions by category",
    )

    assert set(plt.get_fignums()) == before | {fig.number}


def test_generate_all_report_plots_substitutes_one_placeholder_when_driver_charts_fail(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(panels, "get_food_categories", lambda **_: ["fruit"])
    monkeypatch.setattr(panels, "get_drink_categories", lambda **_: [])

    def plot_category_drivers(*_args: Any, **_kwargs: Any):
        plt.figure()
        raise ValueError("boom")

    monkeypatch.setattr(report, "plot_category_drivers", plot_category_drivers)
    before = set(plt.get_fignums())

    plots_output = report.generate_all_report_plots(
        aggregated_data={
            "monthly_category_data": pd.DataFrame(
                {"month_year": ["2023-01"], "category": ["fruit"], "kilos_total": [100]}
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

    placeholder = plots_output[-1][1]
    assert placeholder.axes[0].texts[0].get_text() == "Top Products by Category"
    # The figure the failed plot opened is closed; only the returned pages stay open.
    assert set(plt.get_fignums()) - before == {fig.number for _, fig in plots_output}


@pytest.mark.usefixtures("fruit_and_juice")
def test_generate_all_report_plots_raises_for_untyped_categories():
    monthly_category_data = pd.DataFrame(
        {
            "month_year": ["2023-01", "2023-01"],
            "category": ["fruit", "No Matches Found"],
            "kilos_total": [100, 25],
        }
    )

    with pytest.raises(ValueError, match="Unknown categories"):
        report.generate_all_report_plots(
            aggregated_data=_aggregated_data(
                monthly_category_data, product="apple", category="fruit", total=100
            ),
            diner_meal_mapping={"2023-01": 100},
            metric_total="kilos_total",
        )


@pytest.fixture
def report_plots_with_emissions(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
) -> list[tuple[str, Figure]]:
    return report.generate_all_report_plots(
        aggregated_data=_aggregated_data(
            fruit_and_juice_months(emissions_kg_co2e=[30, 5, 45, 8]),
            product="apple",
            category="fruit",
            total=250,
        ),
        diner_meal_mapping={"2023-01": 100, "2023-02": 100},
        emissions_summary=pd.DataFrame({"category": ["fruit", "juice"], "total_kg_co2e": [75, 13]}),
        metric_total="kilos_total",
    )


def test_generate_all_report_plots_places_category_totals_before_carbon_pages(
    report_plots_with_emissions: list[tuple[str, Figure]],
):
    plots_output = report_plots_with_emissions

    page_titles = [_figure_title(fig) for _, fig in plots_output]

    assert page_titles.index("Kilos by Category Across All Months") < page_titles.index(
        "Carbon Emissions by Category"
    )


def test_generate_all_report_plots_combines_emissions_trends_onto_one_page(
    report_plots_with_emissions: list[tuple[str, Figure]],
):
    plots_output = report_plots_with_emissions

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


def test_generate_all_report_plots_combines_plant_share_panels_onto_one_page():
    monthly_category_data = pd.DataFrame(
        {
            "month_year": ["2023-01", "2023-02"],
            "category": ["legumes", "legumes"],
            "kilos_total": [100, 120],
        }
    )

    plots_output = report.generate_all_report_plots(
        aggregated_data=_aggregated_data(
            monthly_category_data, product="beans", category="legumes", total=220
        ),
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
    assert [ax.get_title() for ax in combined_fig.axes] == [
        "Plant vs. Animal Split",
        "Plant-Based % by Month",
        "Plant Protein Share",
        "Plant Protein % by Month",
    ]
