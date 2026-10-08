"""The report's full set of figures, with a placeholder page for any chart that fails."""

from collections.abc import Callable
from typing import Any

import matplotlib.pyplot as plt
import pandas as pd
from matplotlib.figure import Figure

from gbd_foodservice_insights.plotting_utils import (
    LETTER_LANDSCAPE,
    close_new_figures_on_error,
    standardize_title_case,
)
from gbd_foodservice_insights.report.plots.figures import (
    plot_category_drivers,
    plot_category_totals,
    plot_diner_meal_numbers,
    plot_emissions_by_category,
    plot_emissions_summary_over_time,
    plot_food_and_drink_comparison_page,
    plot_overall_drivers,
    plot_plant_breakdown_overview,
)
from gbd_foodservice_insights.report.plots.panels import filter_monthly_categories_by_type
from gbd_foodservice_insights.report.quality import make_finding
from gbd_foodservice_insights.report.schema import metric_display_label


def _placeholder_figure(title: str, message: str) -> Figure:
    """Create a placeholder figure when a plot cannot be generated."""
    fig, ax = plt.subplots(figsize=LETTER_LANDSCAPE)
    ax.axis("off")
    ax.text(0.5, 0.72, title, ha="center", va="center", fontsize=14, fontweight="bold")
    ax.text(0.5, 0.42, message, ha="center", va="center", fontsize=11, wrap=True)
    return fig


def _normalize_axis_text(value: str) -> str:
    """Normalize axis text so repeated labels can be compared safely."""
    return " ".join(str(value).split()).strip().casefold()


def _remove_duplicate_xlabels(fig: Figure) -> Figure:
    """Remove x-axis labels when they repeat the chart title.

    This stays as a shared cleanup step rather than being hard-coded into
    individual plots, so the report avoids repeated wording consistently
    anywhere this pattern appears in future charts.
    """
    for ax in fig.axes:
        title = ax.get_title()
        x_label = ax.get_xlabel()
        if not title or not x_label:
            continue
        if _normalize_axis_text(title) == _normalize_axis_text(x_label):
            ax.set_xlabel("")
    return fig


def _safe_plot(
    *,
    caption: str,
    plot_fn: Callable[..., Figure],
    quality_findings: list[dict[str, Any]],
    warning_message: str,
    warning_stage: str = "plots",
    input_checks: list[tuple[pd.DataFrame, str]] | None = None,
) -> tuple[str, Figure]:
    """Generate plot and fallback to placeholder with finding on failure."""
    has_input_warning = False
    for df, column in input_checks or []:
        if column not in df.columns:
            quality_findings.append(
                make_finding(
                    stage=warning_stage,
                    category="plot_input_missing_column",
                    status="warning",
                    message=(
                        f"Plot '{caption}' cannot validate '{column}' because the column is "
                        "missing."
                    ),
                    column=column,
                )
            )
            has_input_warning = True
            continue

        missing_count = int(df[column].isna().sum())
        if missing_count > 0:
            quality_findings.append(
                make_finding(
                    stage=warning_stage,
                    category="plot_input_missing_values",
                    status="warning",
                    message=(
                        f"Plot '{caption}' input column '{column}' contains {missing_count} "
                        "missing values."
                    ),
                    column=column,
                    count=missing_count,
                )
            )
            has_input_warning = True

    output_caption = f"{caption} [DATA WARNING]" if has_input_warning else caption

    try:
        with close_new_figures_on_error():
            fig = _remove_duplicate_xlabels(plot_fn())
            if has_input_warning:
                fig.suptitle(output_caption, fontsize=10, color="#b22222", y=0.99)
        return output_caption, fig
    except Exception as exc:
        quality_findings.append(
            make_finding(
                stage=warning_stage,
                category="plot_generation",
                status="warning",
                message=f"{warning_message}: {exc}",
            )
        )
        fallback_fig = _placeholder_figure(
            caption,
            f"Could not generate plot due to data issue:\n{exc}",
        )
        fallback_fig.suptitle(
            f"{caption} [DATA WARNING]",
            fontsize=10,
            color="#b22222",
            y=0.99,
        )
        return (
            f"{caption} [DATA WARNING]",
            fallback_fig,
        )


def generate_all_report_plots(
    aggregated_data: dict[str, Any],
    diner_meal_mapping: dict[Any, Any],
    emissions_summary: pd.DataFrame | None = None,
    metric_total: str = "kilos_total",
    serving: bool = False,
    quality_findings: list[dict[str, Any]] | None = None,
    plant_animal_split: dict[str, Any] | None = None,
    plant_protein_share: dict[str, Any] | None = None,
    diner_or_meal: str = "diner",
) -> list[tuple[str, Figure]]:
    """Generate all report plots and return ``(caption, figure)`` tuples."""
    findings = quality_findings if quality_findings is not None else []
    plots: list[tuple[str, Figure]] = []

    monthly_cat = aggregated_data.get("monthly_category_data", pd.DataFrame())
    overall_drivers = aggregated_data.get("overall_drivers", pd.DataFrame())
    category_drivers = aggregated_data.get("category_drivers", pd.DataFrame())

    if not monthly_cat.empty:
        filter_monthly_categories_by_type(monthly_cat, include_drinks=True)

    metric_label = metric_display_label(metric_total)

    plots.append(
        (
            "",
            _safe_plot(
                caption=f"{diner_or_meal.title()}s by Month",
                plot_fn=lambda: plot_diner_meal_numbers(diner_meal_mapping, diner_or_meal),
                quality_findings=findings,
                warning_message=f"Could not plot {diner_or_meal} numbers",
            )[1],
        )
    )

    plots.append(
        (
            "",
            _safe_plot(
                caption=f"{metric_label} Over Time: Food vs Food + Drink",
                plot_fn=lambda: plot_food_and_drink_comparison_page(
                    monthly_cat,
                    metric=metric_total,
                    diner_meal_mapping=diner_meal_mapping,
                    diner_or_meal=diner_or_meal,
                ),
                quality_findings=findings,
                warning_message="Could not plot food versus food-and-drink trends over time",
                input_checks=[(monthly_cat, "month_year"), (monthly_cat, metric_total)],
            )[1],
        )
    )

    plots.append(
        (
            "",
            _safe_plot(
                caption=f"{metric_label} by Category",
                plot_fn=lambda: plot_category_totals(monthly_cat, metric_total),
                quality_findings=findings,
                warning_message="Could not plot category totals",
                input_checks=[(monthly_cat, "category"), (monthly_cat, metric_total)],
            )[1],
        )
    )

    if emissions_summary is not None and not serving:
        plots.append(
            (
                "",
                _safe_plot(
                    caption="Carbon Emissions by Category",
                    plot_fn=lambda: plot_emissions_by_category(emissions_summary),
                    quality_findings=findings,
                    warning_message="Could not plot emissions by category",
                    input_checks=[
                        (emissions_summary, "category"),
                        (emissions_summary, "total_kg_co2e"),
                    ],
                )[1],
            )
        )

        if "emissions_kg_co2e" in monthly_cat.columns:
            plots.append(
                (
                    "",
                    _safe_plot(
                        caption=(
                            f"Carbon Emissions Over Time: Total and per {diner_or_meal.title()}"
                        ),
                        plot_fn=lambda: plot_emissions_summary_over_time(
                            monthly_cat,
                            diner_meal_mapping,
                            diner_or_meal=diner_or_meal,
                        ),
                        quality_findings=findings,
                        warning_message="Could not plot combined emissions trends over time",
                        input_checks=[
                            (monthly_cat, "month_year"),
                            (monthly_cat, "emissions_kg_co2e"),
                        ],
                    )[1],
                )
            )

    if plant_animal_split is not None or plant_protein_share is not None:
        plots.append(
            (
                "",
                _safe_plot(
                    caption="Plant and Protein Breakdown",
                    plot_fn=lambda: plot_plant_breakdown_overview(
                        plant_animal_split,
                        plant_protein_share,
                        metric_label=metric_label,
                    ),
                    quality_findings=findings,
                    warning_message="Could not plot plant and protein breakdown",
                )[1],
            )
        )

    plots.append(
        (
            "",
            _safe_plot(
                caption="Top Products Overall",
                plot_fn=lambda: plot_overall_drivers(overall_drivers, metric_total),
                quality_findings=findings,
                warning_message="Could not plot overall drivers",
                input_checks=[(overall_drivers, "product"), (overall_drivers, "percentage")],
            )[1],
        )
    )

    try:
        has_input_warning = False
        for required_col in ("category", "product", "percentage"):
            if required_col not in category_drivers.columns:
                findings.append(
                    make_finding(
                        stage="plots",
                        category="plot_input_missing_column",
                        status="warning",
                        message=(
                            "Category-driver plots are missing required input column "
                            f"'{required_col}'."
                        ),
                        column=required_col,
                    )
                )
                has_input_warning = True
                continue

            missing_count = int(category_drivers[required_col].isna().sum())
            if missing_count > 0:
                findings.append(
                    make_finding(
                        stage="plots",
                        category="plot_input_missing_values",
                        status="warning",
                        message=(
                            f"Category-driver plots input column '{required_col}' contains "
                            f"{missing_count} missing values."
                        ),
                        column=required_col,
                        count=missing_count,
                    )
                )
                has_input_warning = True

        # All or nothing: on a failure, the placeholder below replaces every category's chart.
        category_plots: list[tuple[str, Figure]] = []
        with close_new_figures_on_error():
            cat_figs = plot_category_drivers(category_drivers, metric=metric_total)
            for cat_name, fig in cat_figs.items():
                fig = _remove_duplicate_xlabels(fig)
                caption = f"Top Products — {standardize_title_case(cat_name)}"
                if has_input_warning:
                    caption += " [DATA WARNING]"
                    fig.suptitle(caption, fontsize=10, color="#b22222", y=0.99)
                category_plots.append(("", fig))
        plots.extend(category_plots)
    except Exception as exc:
        findings.append(
            make_finding(
                stage="plots",
                category="plot_generation",
                status="warning",
                message=f"Could not generate category-driver plots: {exc}",
            )
        )
        plots.append(
            (
                "",
                _placeholder_figure(
                    "Top Products by Category",
                    f"Could not generate category-driver plots due to data issue:\n{exc}",
                ),
            )
        )

    return plots
