"""The in-memory core of the food report: categorized rows in, report numbers and charts out.

Nothing here reads or writes a file. `pdf.write_report_pdf` and `excel.write_client_workbook`
turn a `FoodReport` into the deliverables; the lab's
`gbd_foodservice_insights_lab.food_report.pipeline.run_food_report` is the file-reading
wrapper that also writes the data scientists' bundle.
"""

import logging
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass

import matplotlib.pyplot as plt
import pandas as pd
from matplotlib.figure import Figure

from gbd_foodservice_insights import emissions
from gbd_foodservice_insights.categories import category_names
from gbd_foodservice_insights.errors import UnusableDataError
from gbd_foodservice_insights.plotting_utils import close_new_figures_on_error
from gbd_foodservice_insights.report import aggregation, checks
from gbd_foodservice_insights.report.aggregation import (
    Aggregation,
    PlantAnimalSplit,
    PlantProteinShare,
    calculate_plant_animal_split,
    calculate_plant_protein_share,
)
from gbd_foodservice_insights.report.metric import KILOS, Metric
from gbd_foodservice_insights.report.plots import report as report_plots
from gbd_foodservice_insights.report.quality import Finding
from gbd_foodservice_insights.report.schema import DinerOrMeal, Region

logger = logging.getLogger(__name__)

_STAGE_MESSAGES = {
    "ingestion": "Loading the input data.",
    "month_normalization": "Creating the month summary column.",
    "diner_meal_mapping": "Loading the diner-meal mapping.",
    "emissions": "Calculating emissions values.",
    "aggregation": "Summarizing the data for the report.",
    "emissions_summary": "Preparing the emissions summary tables.",
    "client_metrics_and_diagnostics": "Running report checks and summary metrics.",
}


@dataclass(frozen=True)
class FoodReport:
    rows: pd.DataFrame
    region: Region
    diner_or_meal: DinerOrMeal
    diner_meal_mapping: dict[pd.Period, float]
    diner_meals_in_data: float
    aggregation: Aggregation
    emissions_summary: pd.DataFrame
    plant_animal_split: PlantAnimalSplit
    # `None` when the rows have no protein.
    plant_protein_share: PlantProteinShare | None
    # In the order they were collected, which is the order the PDF lists them in.
    findings: tuple[Finding, ...]


@dataclass(frozen=True)
class ReportCharts:
    """Closed when the `build_report_charts` block exits."""

    figures: list[Figure]


def _log_stage(stage_key: str, report_progress: Callable[[], None]) -> None:
    logger.info("Step: %s", _STAGE_MESSAGES[stage_key])
    report_progress()


def _ignore() -> None:
    pass


def build_food_report(
    rows: pd.DataFrame,
    *,
    diner_meal_mapping: Mapping[pd.Period, float],
    region: Region,
    diner_or_meal: DinerOrMeal,
    top_n_drivers: int,
    report_progress: Callable[[], None] = _ignore,
) -> FoodReport:
    """Rows that break `validate_rows`' contract raise `TypeError` or `ValueError`; rows that
    weigh nothing, `UnusableDataError`."""
    _log_stage("ingestion", report_progress)
    validate_rows(rows, KILOS)
    # Every figure is a share of this total. `apps/web` refuses a file whose weights are all 0,
    # but only categorized rows reach here, so its uncategorized products can have held them all.
    if (rows[KILOS.column] == 0).all():
        raise UnusableDataError(
            f"Every row has a {KILOS.column} of 0, so there is nothing to report."
        )

    _log_stage("month_normalization", report_progress)
    df = rows.assign(month_year=rows["date"].dt.to_period("M"))

    _log_stage("diner_meal_mapping", report_progress)
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

    _log_stage("emissions", report_progress)
    df = emissions.calculate_emissions(df, region=region)

    _log_stage("aggregation", report_progress)
    agg_results = aggregation.run_aggregation_pipeline(
        df,
        dm_mapping,
        top_n=top_n_drivers,
        region=region,
        diner_or_meal=diner_or_meal,
    )

    _log_stage("emissions_summary", report_progress)
    emissions_summary = emissions.calculate_emissions_per_diner_meal(
        emissions.calculate_emissions_summary(df),
        diner_meals_in_data,
        diner_or_meal,
    )

    _log_stage("client_metrics_and_diagnostics", report_progress)
    plant_animal_split = calculate_plant_animal_split(df, metric_col=KILOS.column)
    plant_protein_share = calculate_plant_protein_share(df, metric_col=KILOS.column)

    findings = checks.run_all_diagnostics(
        df=df,
        diner_meal_mapping=dm_mapping,
        diner_or_meal=diner_or_meal,
    )

    return FoodReport(
        rows=df,
        region=region,
        diner_or_meal=diner_or_meal,
        diner_meal_mapping=dm_mapping,
        diner_meals_in_data=diner_meals_in_data,
        aggregation=agg_results,
        emissions_summary=emissions_summary,
        plant_animal_split=plant_animal_split,
        plant_protein_share=plant_protein_share,
        findings=tuple(findings),
    )


def validate_rows(rows: pd.DataFrame, metric: Metric) -> None:
    required = ("date", "product", "category", metric.column)
    missing = [column for column in required if column not in rows.columns]
    if missing:
        raise ValueError(f"Missing required columns: {', '.join(missing)}")
    for column in required:
        null_count = int(rows[column].isna().sum())
        if null_count:
            raise ValueError(f"{column} is missing in {null_count:,} of {len(rows):,} rows")

    if not pd.api.types.is_datetime64_dtype(rows["date"]):
        raise TypeError(f"date must be datetime64, not {rows['date'].dtype}")
    if not pd.api.types.is_numeric_dtype(rows[metric.column]):
        raise TypeError(f"{metric.column} must be numeric, not {rows[metric.column].dtype}")

    negative_count = int((rows[metric.column] < 0).sum())
    if negative_count:
        raise ValueError(f"{metric.column} is negative in {negative_count:,} of {len(rows):,} rows")
    # Exact names: every step below compares categories exactly, so `beef` would get no
    # emission factor and fall out of every plant, animal and protein figure.
    gbd_categories = set(category_names())
    unknown = sorted({str(c) for c in rows["category"].unique() if c not in gbd_categories})
    if unknown:
        raise ValueError(f"Not GBD categories: {', '.join(unknown)}")


@contextmanager
def build_report_charts(report: FoodReport) -> Generator[ReportCharts]:
    with close_new_figures_on_error():
        figures = report_plots.generate_all_report_plots(
            aggregation=report.aggregation,
            diner_meal_mapping=report.diner_meal_mapping,
            emissions_summary=report.emissions_summary,
            plant_animal_split=report.plant_animal_split,
            plant_protein_share=report.plant_protein_share,
            diner_or_meal=report.diner_or_meal,
        )
    try:
        yield ReportCharts(figures=figures)
    finally:
        for figure in figures:
            plt.close(figure)


def date_range_label(rows: pd.DataFrame) -> str:
    """The months the rows span, as in "Jan 2024 – Mar 2024"."""
    first, last = rows["date"].min().strftime("%b %Y"), rows["date"].max().strftime("%b %Y")
    return first if first == last else f"{first} – {last}"
