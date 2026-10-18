"""The serving report: servings per entree instead of kilos, and so no emissions.

The product reports only procurement data, so the lab owns this report. It composes the
product's leaves — validation, aggregation, checks, charts and PDF pages — with `SERVINGS` where
the product passes `KILOS`. Its PDF leaves out the product's "How to Read This Report" and "About
This Report" pages, which are written about procurement data.
"""

import logging
from collections.abc import Generator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import matplotlib.pyplot as plt
import pandas as pd
from gbd_foodservice_insights.errors import UnusableDataError
from gbd_foodservice_insights.plotting_utils import LETTER_PORTRAIT, close_new_figures_on_error
from gbd_foodservice_insights.report import checks
from gbd_foodservice_insights.report.aggregation import (
    PlantAnimalSplit,
    PlantProteinShare,
    aggregate_data,
    calculate_plant_animal_split,
    calculate_plant_protein_share,
    create_template_data,
    identify_category_drivers,
    identify_overall_drivers,
)
from gbd_foodservice_insights.report.excel import diner_meals_frame, write_excel_workbook
from gbd_foodservice_insights.report.food_report import ReportCharts, validate_rows
from gbd_foodservice_insights.report.metric import Metric
from gbd_foodservice_insights.report.pdf import (
    create_category_template_pages,
    create_text_page,
    create_title_page,
    new_summary_figure,
    quality_lines,
)
from gbd_foodservice_insights.report.plots.figures import (
    plot_category_drivers_pages,
    plot_category_totals,
    plot_diner_meal_numbers,
    plot_food_and_drink_comparison_page,
    plot_overall_drivers,
    plot_plant_breakdown_overview,
)
from gbd_foodservice_insights.report.quality import Finding
from gbd_foodservice_insights.report.schema import (
    DinerOrMeal,
    Headcounts,
    quality_status_from_findings,
)
from matplotlib.backends.backend_pdf import PdfPages

logger = logging.getLogger(__name__)

SERVINGS = Metric(
    column="servings total",
    label="Servings",
    unit_singular="serving",
    unit_plural="servings",
    per_head_stem="servings",
    line_noun="serving count",
)
# A line outside these usually means a unit mistake, such as kilos in the servings column.
SERVING_LINE_BOUNDS = (1.0, 1000.0)
_SUMMARY_MARGIN_IN = 1.0


@dataclass(frozen=True)
class ServingReport:
    rows: pd.DataFrame
    metric: Metric
    diner_or_meal: DinerOrMeal
    diner_meal_mapping: dict[pd.Period, float]
    diner_meals_in_data: float
    monthly_product: pd.DataFrame
    monthly_category: pd.DataFrame
    template: pd.DataFrame
    overall_drivers: pd.DataFrame
    category_drivers: pd.DataFrame
    plant_animal_split: PlantAnimalSplit
    # `None` when the rows have no protein.
    plant_protein_share: PlantProteinShare | None
    # In the order they were collected, which is the order the PDF lists them in.
    findings: tuple[Finding, ...]
    # Without "Data Quality Status", which the lab's own findings can still change.
    summary_stats: dict[str, str]


def build_serving_report(
    rows: pd.DataFrame,
    *,
    diner_meal_mapping: Mapping[pd.Period, float],
    diner_or_meal: DinerOrMeal,
    top_n_drivers: int,
) -> ServingReport:
    """Rows that break `validate_rows`' contract raise `TypeError` or `ValueError`; rows that
    count no servings, `UnusableDataError`."""
    validate_rows(rows, SERVINGS)
    if (rows[SERVINGS.column] == 0).all():
        raise UnusableDataError(
            f"Every row has a {SERVINGS.column} of 0, so there is nothing to report."
        )

    df = rows.assign(month_year=rows["date"].dt.to_period("M"))
    dm_mapping = {month: float(count) for month, count in diner_meal_mapping.items()}
    months_with_rows = set(df["month_year"])
    uncounted = sorted(month for month in months_with_rows if not dm_mapping.get(month, 0) > 0)
    if uncounted:
        raise ValueError(
            f"No positive {diner_or_meal} count for {', '.join(str(month) for month in uncounted)}"
        )
    diner_meals_in_data = float(
        sum(count for month, count in dm_mapping.items() if month in months_with_rows)
    )

    monthly_category = _monthly(df, "category", dm_mapping, diner_or_meal)
    plant_animal_split = calculate_plant_animal_split(df, metric_col=SERVINGS.column)
    plant_protein_share = calculate_plant_protein_share(df, metric_col=SERVINGS.column)
    return ServingReport(
        rows=df,
        metric=SERVINGS,
        diner_or_meal=diner_or_meal,
        diner_meal_mapping=dm_mapping,
        diner_meals_in_data=diner_meals_in_data,
        monthly_product=_monthly(df, "product", dm_mapping, diner_or_meal),
        monthly_category=monthly_category,
        template=create_template_data(monthly_category, SERVINGS.column),
        overall_drivers=identify_overall_drivers(df, metric=SERVINGS.column, top_n=top_n_drivers),
        category_drivers=identify_category_drivers(df, metric=SERVINGS.column, top_n=top_n_drivers),
        plant_animal_split=plant_animal_split,
        plant_protein_share=plant_protein_share,
        findings=_findings(df, dm_mapping, diner_or_meal),
        summary_stats=_summary_stats(
            df,
            diner_or_meal=diner_or_meal,
            diner_meals_in_data=diner_meals_in_data,
            plant_animal_split=plant_animal_split,
            plant_protein_share=plant_protein_share,
        ),
    )


def _monthly(
    df: pd.DataFrame,
    group_by: Literal["product", "category"],
    diner_meal_mapping: Mapping[pd.Period, float],
    diner_or_meal: DinerOrMeal,
) -> pd.DataFrame:
    totals = aggregate_data(df, group_by=group_by, metric=SERVINGS.column)
    return totals.assign(
        **{
            SERVINGS.per_head(diner_or_meal): totals[SERVINGS.column]
            / totals["month_year"].map(diner_meal_mapping)
        }
    )


def _findings(
    df: pd.DataFrame,
    diner_meal_mapping: Mapping[pd.Period, float],
    diner_or_meal: DinerOrMeal,
) -> tuple[Finding, ...]:
    """The product's report checks, in the order `checks.run_all_diagnostics` runs them."""
    low, high = SERVING_LINE_BOUNDS
    reasonableness, _ = checks.check_diner_meal_reasonableness(
        df, diner_meal_mapping, SERVINGS.column, diner_or_meal=diner_or_meal
    )
    unusual_sales, _ = checks.detect_unusual_sales(
        df, SERVINGS, product_name_col="product", category_col="category"
    )
    out_of_bounds, _ = checks.check_per_product_weight_bounds(df, SERVINGS, low=low, high=high)
    return (
        *checks.detect_month_over_month_total_volatility(df, SERVINGS),
        *checks.check_missing_internal_months(df),
        *reasonableness,
        *unusual_sales,
        *out_of_bounds,
        *checks.check_date_distribution(df),
    )


def _summary_stats(
    df: pd.DataFrame,
    *,
    diner_or_meal: DinerOrMeal,
    diner_meals_in_data: float,
    plant_animal_split: PlantAnimalSplit,
    plant_protein_share: PlantProteinShare | None,
) -> dict[str, str]:
    first, last = df["date"].min().strftime("%b %Y"), df["date"].max().strftime("%b %Y")
    unit = SERVINGS.unit_plural
    stats = {
        "Total rows": f"{len(df):,}",
        "Unique products": f"{df['product'].nunique():,}",
        "Date range": first if first == last else f"{first} – {last}",
        f"Total {diner_or_meal}s": f"{diner_meals_in_data:,.0f}",
        "Data type": "Serving",
        "Plant-based (% of classified food)": f"{plant_animal_split.plant_pct:.1f}%",
        "Animal-based (% of classified food)": f"{plant_animal_split.animal_pct:.1f}%",
        "Plant-based total": f"{plant_animal_split.plant_total:,.1f} {unit}",
        "Animal-based total": f"{plant_animal_split.animal_total:,.1f} {unit}",
    }
    if plant_protein_share is None:
        return stats
    return stats | {
        "Plant protein share (% of protein categories)": (
            f"{plant_protein_share.plant_protein_pct:.1f}%"
        ),
        "Plant protein total": f"{plant_protein_share.plant_protein_total:,.1f} {unit}",
        "Protein-category total": f"{plant_protein_share.protein_total:,.1f} {unit}",
    }


@contextmanager
def serving_charts(report: ServingReport) -> Generator[ReportCharts]:
    with close_new_figures_on_error():
        figures = [
            plot_diner_meal_numbers(report.diner_meal_mapping, report.diner_or_meal),
            plot_food_and_drink_comparison_page(
                report.monthly_category,
                metric=SERVINGS,
                headcounts=Headcounts(report.diner_or_meal, report.diner_meal_mapping),
            ),
            plot_category_totals(report.monthly_category, SERVINGS),
            plot_plant_breakdown_overview(
                report.plant_animal_split, report.plant_protein_share, metric=SERVINGS
            ),
            plot_overall_drivers(report.overall_drivers, SERVINGS),
            *plot_category_drivers_pages(
                report.category_drivers,
                report.category_drivers["category"].dropna().unique().tolist(),
                metric=SERVINGS,
            ),
        ]
    try:
        yield ReportCharts(figures=figures)
    finally:
        for figure in figures:
            plt.close(figure)


def write_serving_pdf(
    report: ServingReport,
    charts: ReportCharts,
    path: Path,
    *,
    client_name: str,
    show_quality_successes: bool,
) -> None:
    quality_status = quality_status_from_findings(report.findings)
    with close_new_figures_on_error(), PdfPages(path) as pdf:
        create_title_page(pdf, client_name, "Serving")
        _create_summary_page(
            pdf, {**report.summary_stats, "Data Quality Status": quality_status.upper()}
        )
        for figure in charts.figures:
            pdf.savefig(figure)
        create_category_template_pages(pdf, report.template)
        create_text_page(
            pdf,
            "Data Completeness & Quality",
            quality_lines(report.findings, show_successes=show_quality_successes),
        )
    logger.info("Serving PDF report saved to %s", path)


def _create_summary_page(
    pdf: PdfPages,
    summary_stats: dict[str, str],
    fig_size: tuple[float, float] = LETTER_PORTRAIT,
) -> None:
    """The executive summary as a ``label: value`` listing, until the data scientists write a
    serving report's prose."""
    fig, ax = new_summary_figure(fig_size)
    y = 0.74
    for label, value in summary_stats.items():
        ax.text(
            _SUMMARY_MARGIN_IN / fig_size[0],
            y,
            f"{label}:  {value}",
            transform=ax.transAxes,
            ha="left",
            va="top",
            fontsize=12,
            fontfamily="Lato",
        )
        y -= 0.035
    pdf.savefig(fig)
    plt.close(fig)


def write_serving_workbook(report: ServingReport, path: Path) -> None:
    write_excel_workbook(
        path,
        {
            "Monthly by Product": report.monthly_product,
            "Monthly by Category": report.monthly_category,
            "Template": report.template.reset_index(),
            f"{report.diner_or_meal.title()}s": diner_meals_frame(
                report.diner_meal_mapping, report.diner_or_meal
            ),
        },
    )
    logger.info("Serving Excel report saved to %s", path)
