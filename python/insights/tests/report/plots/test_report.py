from collections.abc import Callable
from typing import Any

import matplotlib.pyplot as plt
import pandas as pd
import pytest
from gbd_foodservice_insights.report.plots import panels, report
from matplotlib.figure import Figure

DINER_MEALS = {"2023-01": 100, "2023-02": 100}
EMISSIONS_SUMMARY = pd.DataFrame({"category": ["fruit", "juice"], "total_kg_co2e": [75, 13]})


def _figure_title(fig: Figure) -> str:
    """Return a figure-level title when present, otherwise its first panel title."""
    return fig.get_suptitle() or fig.axes[0].get_title()


def _aggregated_data(
    monthly_category_data: pd.DataFrame,
    *,
    category_drivers: pd.DataFrame | None = None,
) -> dict[str, pd.DataFrame]:
    """Aggregates where apple drives everything, for tests that only vary the months."""
    return {
        "monthly_category_data": monthly_category_data,
        "overall_drivers": pd.DataFrame({"product": ["apple"], "percentage": ["100.0%"]}),
        "category_drivers": (
            category_drivers
            if category_drivers is not None
            else pd.DataFrame(
                {"category": ["fruit"], "product": ["apple"], "percentage": ["100.0%"]}
            )
        ),
    }


@pytest.mark.parametrize(
    ("x_label", "expected"),
    [
        ("carbon  emissions by CATEGORY ", ""),
        ("Total kg CO2e", "Total kg CO2e"),
    ],
    ids=["repeats the title", "says something else"],
)
def test_remove_duplicate_xlabels_clears_only_an_x_label_that_repeats_the_title(
    x_label: str, expected: str
):
    fig, ax = plt.subplots()
    ax.set_title("Carbon Emissions by Category")
    ax.set_xlabel(x_label)

    cleaned = report._remove_duplicate_xlabels(fig)

    assert cleaned.axes[0].get_xlabel() == expected


def test_safe_plot_marks_placeholder_figures_with_data_warning():
    """A fallback chart should still show a visible warning label in the PDF itself."""
    findings: list[dict[str, Any]] = []

    caption, fig = report._safe_plot(
        caption="Carbon Emissions by Category",
        plot_fn=lambda: (_ for _ in ()).throw(ValueError("boom")),
        quality_findings=findings,
        warning_message="Could not plot emissions by category",
    )

    assert caption == "Carbon Emissions by Category [DATA WARNING]"
    assert _figure_title(fig) == "Carbon Emissions by Category [DATA WARNING]"
    assert [text.get_text() for text in fig.axes[0].texts] == [
        "Carbon Emissions by Category",
        "Could not generate plot due to data issue:\nboom",
    ]
    assert findings == [
        {
            "stage": "plots",
            "category": "plot_generation",
            "status": "warning",
            "message": "Could not plot emissions by category: boom",
        }
    ]


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


@pytest.mark.parametrize(
    ("column", "expected_finding"),
    [
        (
            "percentage",
            {
                "stage": "plots",
                "category": "plot_input_missing_column",
                "status": "warning",
                "message": "Plot 'Drivers' cannot validate 'percentage' because the column is "
                "missing.",
                "column": "percentage",
            },
        ),
        (
            "product",
            {
                "stage": "plots",
                "category": "plot_input_missing_values",
                "status": "warning",
                "message": "Plot 'Drivers' input column 'product' contains 1 missing values.",
                "column": "product",
                "count": 1,
            },
        ),
    ],
    ids=["missing column", "missing values"],
)
def test_safe_plot_keeps_the_chart_but_marks_it_when_its_input_is_incomplete(
    column: str, expected_finding: dict[str, Any]
):
    findings: list[dict[str, Any]] = []
    chart, _ax = plt.subplots()

    caption, fig = report._safe_plot(
        caption="Drivers",
        plot_fn=lambda: chart,
        quality_findings=findings,
        warning_message="Could not plot drivers",
        input_checks=[(pd.DataFrame({"product": ["apple", None]}), column)],
    )

    assert fig is chart
    assert caption == "Drivers [DATA WARNING]"
    assert fig.get_suptitle() == "Drivers [DATA WARNING]"
    assert findings == [expected_finding]


def test_generate_all_report_plots_orders_every_page(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    plots_output = report.generate_all_report_plots(
        aggregated_data=_aggregated_data(fruit_and_juice_months(emissions_kg_co2e=[30, 5, 45, 8])),
        diner_meal_mapping=DINER_MEALS,
        emissions_summary=EMISSIONS_SUMMARY,
        metric_total="kilos_total",
        plant_animal_split={"plant_pct": 52.0},
    )

    assert [caption for caption, _ in plots_output] == [""] * len(plots_output)
    assert [_figure_title(fig) for _, fig in plots_output] == [
        "Number of Diners by Month",
        "Kilos Over Time",
        "Kilos by Category Across All Months",
        "Carbon Emissions by Category",
        "Carbon Emissions Over Time",
        "Plant and Protein Breakdown",
        "Top Products Driving Overall (Kilos)",
        "Top Products Driving Fruit",
    ]


@pytest.mark.parametrize(
    ("options", "drop_emissions_column", "expected_carbon_pages"),
    [
        ({"emissions_summary": EMISSIONS_SUMMARY, "serving": True}, False, []),
        ({}, False, []),
        ({"emissions_summary": EMISSIONS_SUMMARY}, True, ["Carbon Emissions by Category"]),
    ],
    ids=["serving report", "no emissions summary", "no monthly emissions"],
)
def test_generate_all_report_plots_leaves_out_pages_without_their_data(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
    options: dict[str, Any],
    drop_emissions_column: bool,
    expected_carbon_pages: list[str],
):
    months = fruit_and_juice_months(emissions_kg_co2e=[30, 5, 45, 8])
    if drop_emissions_column:
        months = months.drop(columns="emissions_kg_co2e")

    plots_output = report.generate_all_report_plots(
        aggregated_data=_aggregated_data(months),
        diner_meal_mapping=DINER_MEALS,
        metric_total="kilos_total",
        **options,
    )

    # No plant inputs either, so every case also leaves out the plant page.
    assert [_figure_title(fig) for _, fig in plots_output] == [
        "Number of Diners by Month",
        "Kilos Over Time",
        "Kilos by Category Across All Months",
        *expected_carbon_pages,
        "Top Products Driving Overall (Kilos)",
        "Top Products Driving Fruit",
    ]


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
            aggregated_data=_aggregated_data(monthly_category_data),
            diner_meal_mapping={"2023-01": 100},
            metric_total="kilos_total",
        )


def test_generate_all_report_plots_marks_driver_charts_whose_input_is_incomplete(
    fruit_and_juice_months: Callable[..., pd.DataFrame],
):
    findings: list[dict[str, Any]] = []

    plots_output = report.generate_all_report_plots(
        aggregated_data=_aggregated_data(
            fruit_and_juice_months(),
            category_drivers=pd.DataFrame(
                {
                    "category": ["fruit", "fruit"],
                    "product": ["apple", "pear"],
                    "percentage": ["60.0%", None],
                }
            ),
        ),
        diner_meal_mapping=DINER_MEALS,
        metric_total="kilos_total",
        quality_findings=findings,
    )

    assert _figure_title(plots_output[-1][1]) == "Top Products — Fruit [DATA WARNING]"
    assert findings == [
        {
            "stage": "plots",
            "category": "plot_input_missing_values",
            "status": "warning",
            "message": "Category-driver plots input column 'percentage' contains 1 missing values.",
            "column": "percentage",
            "count": 1,
        }
    ]


def test_generate_all_report_plots_substitutes_one_placeholder_when_driver_charts_fail(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(panels, "get_food_categories", lambda **_: ["fruit"])
    monkeypatch.setattr(panels, "get_drink_categories", lambda **_: [])

    def plot_category_drivers(*_args: Any, **_kwargs: Any):
        plt.figure()
        raise ValueError("boom")

    monkeypatch.setattr(report, "plot_category_drivers", plot_category_drivers)
    findings: list[dict[str, Any]] = []
    before = set(plt.get_fignums())

    plots_output = report.generate_all_report_plots(
        aggregated_data=_aggregated_data(
            pd.DataFrame({"month_year": ["2023-01"], "category": ["fruit"], "kilos_total": [100]})
        ),
        diner_meal_mapping={"2023-01": 100},
        metric_total="kilos_total",
        quality_findings=findings,
    )

    placeholder = plots_output[-1][1]
    assert [text.get_text() for text in placeholder.axes[0].texts] == [
        "Top Products by Category",
        "Could not generate category-driver plots due to data issue:\nboom",
    ]
    assert findings == [
        {
            "stage": "plots",
            "category": "plot_generation",
            "status": "warning",
            "message": "Could not generate category-driver plots: boom",
        }
    ]
    # The figure the failed plot opened is closed; only the returned pages stay open.
    assert set(plt.get_fignums()) - before == {fig.number for _, fig in plots_output}
