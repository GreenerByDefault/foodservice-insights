from collections.abc import Callable
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights.report import plots
from matplotlib.figure import Figure


@pytest.fixture(autouse=True)
def cleanup_plt():
    yield
    plt.close("all")


@pytest.fixture
def fruit_and_juice(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(plots, "get_food_categories", lambda **_: ["fruit"])
    monkeypatch.setattr(plots, "get_drink_categories", lambda **_: ["juice"])


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


def _fruit_and_juice_months(**extra_columns: list[float]) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "month_year": ["2023-01", "2023-01", "2023-02", "2023-02"],
            "category": ["fruit", "juice", "fruit", "juice"],
            "kilos_total": [100, 25, 150, 40],
            **extra_columns,
        }
    )


def test_plot_category_drivers_draws_one_titled_chart_per_category():
    drivers = pd.DataFrame(
        {
            "category": ["fruit", "fruit", "farmer's oat milk"],
            "product": ["apple", "banana", "oat milk"],
            "percentage": ["60.0%", "40.0%", "100.0%"],
        }
    )

    figs = plots.plot_category_drivers(drivers, metric="kilos_total")

    assert {category: _figure_title(fig) for category, fig in figs.items()} == {
        "fruit": "Top Products Driving Fruit",
        "farmer's oat milk": "Top Products Driving Farmer's Oat Milk",
    }


def test_remove_duplicate_xlabels_clears_an_x_label_that_repeats_the_title():
    fig, ax = plt.subplots()
    ax.set_title("Carbon Emissions by Category")
    ax.set_xlabel("Carbon Emissions by Category")

    cleaned = plots._remove_duplicate_xlabels(fig)

    assert cleaned.axes[0].get_xlabel() == ""


def test_safe_plot_marks_placeholder_figures_with_data_warning():
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


def test_safe_plot_closes_the_figure_a_failed_plot_opened():
    before = set(plt.get_fignums())

    def plot_fn():
        plt.figure()
        raise ValueError("boom")

    _caption, fig = plots._safe_plot(
        caption="Carbon Emissions by Category",
        plot_fn=plot_fn,
        quality_findings=[],
        warning_message="Could not plot emissions by category",
    )

    assert set(plt.get_fignums()) == before | {fig.number}


def _y_values(ax: plt.Axes) -> list[list[float]]:
    return [np.asarray(line.get_ydata()).tolist() for line in ax.lines]


def _texts(ax: plt.Axes) -> list[str]:
    return [text.get_text() for text in ax.texts]


@pytest.mark.usefixtures("fruit_and_juice")
def test_food_and_drink_comparison_page_puts_totals_beside_per_diner():
    fig = plots.plot_food_and_drink_comparison_page(
        _fruit_and_juice_months(),
        metric="kilos_total",
        diner_meal_mapping={"2023-01": 100, "2023-02": 100},
    )

    assert _figure_title(fig) == "Kilos Over Time"
    assert [ax.get_title() for ax in fig.axes] == ["Total Kilos", "Kilos per Diner"]


@pytest.mark.usefixtures("fruit_and_juice")
def test_draw_food_and_drink_totals_draws_food_only_then_food_and_drink():
    _fig, ax = plt.subplots()

    plots.draw_food_and_drink_totals(ax, _fruit_and_juice_months(), metric="kilos_total")

    assert ax.get_title() == "Total Kilos"
    assert [line.get_label() for line in ax.lines] == ["Food Only", "Food + Drink"]
    assert _y_values(ax) == [[100, 150], [125, 190]]


@pytest.mark.usefixtures("fruit_and_juice")
def test_draw_food_and_drink_per_diner_divides_by_diner_meals():
    _fig, ax = plt.subplots()

    plots.draw_food_and_drink_per_diner(
        ax,
        _fruit_and_juice_months(),
        {"2023-01": 100, "2023-02": 100},
        metric="kilos_total",
        diner_or_meal="meal",
    )

    assert ax.get_title() == "Kilos per Meal"
    assert _y_values(ax) == [[1.0, 1.5], [1.25, 1.9]]


@pytest.mark.usefixtures("fruit_and_juice")
def test_draw_food_and_drink_totals_says_so_when_no_category_matches():
    _fig, ax = plt.subplots()

    plots.draw_food_and_drink_totals(ax, _fruit_and_juice_months().iloc[0:0])

    assert not ax.axison
    assert _texts(ax) == ["No matching category data available."]


@pytest.mark.usefixtures("fruit_and_juice")
def test_draw_food_and_drink_totals_rejects_a_metric_without_food_and_drink():
    _fig, ax = plt.subplots()

    with pytest.raises(ValueError, match="metric must be"):
        plots.draw_food_and_drink_totals(ax, _fruit_and_juice_months(), metric="emissions_kg_co2e")


def test_draw_total_emissions_abbreviates_large_values():
    _fig, ax = plt.subplots()

    plots.draw_total_emissions(ax, _fruit_and_juice_months(emissions_kg_co2e=[2e6, 5e5, 3e3, 12]))

    assert ax.get_title() == "Total Carbon Emissions Over Time"
    assert _y_values(ax) == [[2.5e6, 3012.0]]
    formatter = ax.yaxis.get_major_formatter()
    assert [formatter(value, None) for value in (2.5e6, 3012, 12)] == ["2.5M", "3k", "12"]


def test_draw_emissions_per_diner_divides_by_diner_meals():
    _fig, ax = plt.subplots()

    plots.draw_emissions_per_diner(
        ax,
        _fruit_and_juice_months(emissions_kg_co2e=[30, 5, 45, 8]),
        {"2023-01": 10, "2023-02": 20},
    )

    assert ax.get_title() == "Carbon Emissions per Diner Over Time"
    assert _y_values(ax) == [[3.5, 2.65]]


def test_draw_plant_animal_split_labels_both_shares():
    _fig, ax = plt.subplots()

    plots.draw_plant_animal_split(ax, {"plant_pct": 52.0}, metric_label="Servings")

    assert ax.get_title() == "Plant vs. Animal Split"
    assert ax.get_xlabel() == "% of total servings (plant + animal categories only)"
    assert ax.get_legend_handles_labels()[1] == [
        "Plant-based (52.0%)",
        "Animal-based (48.0%)",
    ]


def test_draw_plant_protein_share_labels_both_shares():
    _fig, ax = plt.subplots()

    plots.draw_plant_protein_share(ax, {"plant_protein_pct": 55.0})

    assert ax.get_title() == "Plant Protein Share"
    assert ax.get_legend_handles_labels()[1] == [
        "Plant protein (55.0%)",
        "Other protein (45.0%)",
    ]


@pytest.mark.parametrize(
    ("draw", "share", "expected"),
    [
        (
            plots.draw_plant_share_by_month,
            {
                "monthly": pd.DataFrame(
                    {"month_year": ["2023-02", "2023-01"], "plant_pct": [55.3, 48.0]}
                )
            },
            "Plant-Based % by Month",
        ),
        (
            plots.draw_plant_protein_share_by_month,
            {
                "monthly": pd.DataFrame(
                    {"month_year": ["2023-02", "2023-01"], "plant_protein_pct": [55.3, 48.0]}
                )
            },
            "Plant Protein % by Month",
        ),
    ],
)
def test_monthly_plant_drawers_plot_the_share_in_month_order(
    draw: Callable[[plt.Axes, dict[str, Any]], None], share: dict[str, Any], expected: str
):
    _fig, ax = plt.subplots()

    draw(ax, share)

    assert ax.get_title() == expected
    assert _y_values(ax) == [[48.0, 55.3], [50, 50]]  # The second is the 50% reference line.


@pytest.mark.parametrize(
    ("draw", "share", "expected"),
    [
        (
            plots.draw_plant_animal_split,
            None,
            ["Plant vs. Animal Split", "Plant/animal data was not available."],
        ),
        (
            plots.draw_plant_protein_share,
            None,
            ["Plant Protein Share", "Plant protein data was not available."],
        ),
        (
            plots.draw_plant_share_by_month,
            None,
            ["Plant-Based % by Month", "Monthly plant/animal data was not available."],
        ),
        (
            plots.draw_plant_share_by_month,
            {"plant_pct": 52.0},
            ["Plant-Based % by Month", "Monthly plant/animal data was not available."],
        ),
        (
            plots.draw_plant_protein_share_by_month,
            {"plant_protein_pct": 55.0, "monthly": pd.DataFrame()},
            ["Plant Protein % by Month", "Monthly plant protein data was not available."],
        ),
    ],
)
def test_plant_drawers_keep_their_title_when_data_is_unavailable(
    draw: Callable[[plt.Axes, dict[str, Any] | None], None],
    share: dict[str, Any] | None,
    expected: list[str],
):
    _fig, ax = plt.subplots()

    draw(ax, share)

    assert not ax.axison
    assert _texts(ax) == expected


def test_generate_all_report_plots_substitutes_one_placeholder_when_driver_charts_fail(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(plots, "get_food_categories", lambda **_: ["fruit"])
    monkeypatch.setattr(plots, "get_drink_categories", lambda **_: [])

    def plot_category_drivers(*_args: Any, **_kwargs: Any):
        plt.figure()
        raise ValueError("boom")

    monkeypatch.setattr(plots, "plot_category_drivers", plot_category_drivers)
    before = set(plt.get_fignums())

    plots_output = plots.generate_all_report_plots(
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
        plots.generate_all_report_plots(
            aggregated_data=_aggregated_data(
                monthly_category_data, product="apple", category="fruit", total=100
            ),
            diner_meal_mapping={"2023-01": 100},
            metric_total="kilos_total",
        )


def _report_plots_with_emissions() -> list[tuple[str, Figure]]:
    return plots.generate_all_report_plots(
        aggregated_data=_aggregated_data(
            _fruit_and_juice_months(emissions_kg_co2e=[30, 5, 45, 8]),
            product="apple",
            category="fruit",
            total=250,
        ),
        diner_meal_mapping={"2023-01": 100, "2023-02": 100},
        emissions_summary=pd.DataFrame({"category": ["fruit", "juice"], "total_kg_co2e": [75, 13]}),
        metric_total="kilos_total",
    )


@pytest.mark.usefixtures("fruit_and_juice")
def test_generate_all_report_plots_places_category_totals_before_carbon_pages():
    plots_output = _report_plots_with_emissions()

    page_titles = [_figure_title(fig) for _, fig in plots_output]

    assert page_titles.index("Kilos by Category Across All Months") < page_titles.index(
        "Carbon Emissions by Category"
    )


@pytest.mark.usefixtures("fruit_and_juice")
def test_generate_all_report_plots_combines_emissions_trends_onto_one_page():
    plots_output = _report_plots_with_emissions()

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

    plots_output = plots.generate_all_report_plots(
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
