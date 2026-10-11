"""The in-memory core of the food report: categorized rows in, report numbers and charts out.

Nothing here reads or writes a file. `pdf.write_report_pdf` and `excel.write_client_workbook`
turn a `FoodReport` into the deliverables; the lab's
`gbd_foodservice_insights_lab.food_report.pipeline.run_food_report` is the file-reading
wrapper that also writes the data scientists' bundle.
"""

import logging
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Literal

import matplotlib.pyplot as plt
import pandas as pd
from matplotlib.figure import Figure

from gbd_foodservice_insights import emissions
from gbd_foodservice_insights.categories import category_names
from gbd_foodservice_insights.errors import UnusableDataError
from gbd_foodservice_insights.plotting_utils import close_new_figures_on_error
from gbd_foodservice_insights.report import aggregation, checks
from gbd_foodservice_insights.report.aggregation import (
    calculate_plant_animal_split,
    calculate_plant_protein_share,
)
from gbd_foodservice_insights.report.plots import report as report_plots
from gbd_foodservice_insights.report.quality import Finding
from gbd_foodservice_insights.report.schema import (
    DinerOrMeal,
    Region,
    ReportMode,
    metric_display_label,
    metric_for_mode,
    required_columns_for_mode,
)
from gbd_foodservice_insights.report.utils import (
    ensure_month_year_column,
    normalize_diner_meal_mapping,
)

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

# Shown only for procurement, and only when non-empty.
ProcurementTable = Literal["animal_emissions_intensity", "decision_kpis", "substitution_scenarios"]


@dataclass(frozen=True)
class FoodReport:
    rows: pd.DataFrame
    mode: ReportMode
    region: Region
    diner_or_meal: DinerOrMeal
    diner_meal_mapping: dict[pd.Period, float]
    diner_meals_in_data: float
    aggregation: dict[str, pd.DataFrame]
    emissions_summary: pd.DataFrame | None
    plant_animal_split: dict[str, Any] | None
    plant_protein_share: dict[str, Any] | None
    # In the order they were collected, which is the order the PDF lists them in.
    findings: tuple[Finding, ...]
    # Without "Data Quality Status", which the lab's own findings can still change.
    summary_stats: dict[str, str]

    @property
    def metric_total(self) -> str:
        return metric_for_mode(self.mode)

    def procurement_table(self, name: ProcurementTable) -> pd.DataFrame | None:
        if self.mode != "procurement":
            return None
        table = self.aggregation.get(name)
        return table if isinstance(table, pd.DataFrame) and not table.empty else None


@dataclass(frozen=True)
class ReportCharts:
    """Closed when the `build_report_charts` block exits."""

    figures: list[tuple[str, Figure]]


def _log_stage(stage_key: str, report_progress: Callable[[], None]) -> None:
    logger.info("Step: %s", _STAGE_MESSAGES[stage_key])
    report_progress()


def _ignore() -> None:
    pass


def build_food_report(
    rows: pd.DataFrame,
    *,
    diner_meal_mapping: Mapping[Any, Any],
    mode: ReportMode,
    region: Region,
    diner_or_meal: DinerOrMeal,
    top_n_drivers: int,
    report_progress: Callable[[], None] = _ignore,
) -> FoodReport:
    """Rows that break `_validate_rows`' contract raise `TypeError` or `ValueError`; rows that
    weigh nothing, `UnusableDataError`."""
    metric_total = metric_for_mode(mode)

    _log_stage("ingestion", report_progress)
    _validate_rows(rows, mode)
    # Every figure is a share of this total. `apps/web` refuses a file whose weights are all 0,
    # but only categorized rows reach here, so its uncategorized products can have held them all.
    if (rows[metric_total] == 0).all():
        raise UnusableDataError(
            f"Every row has a {metric_total} of 0, so there is nothing to report."
        )

    _log_stage("month_normalization", report_progress)
    df = ensure_month_year_column(rows, date_col="date", month_col="month_year")

    _log_stage("diner_meal_mapping", report_progress)
    dm_mapping = normalize_diner_meal_mapping(diner_meal_mapping)
    months_with_rows = set(df["month_year"].dropna())
    diner_meals_in_data = float(
        sum(count for month, count in dm_mapping.items() if month in months_with_rows)
    )

    _log_stage("emissions", report_progress)
    emissions_summary = None
    if mode == "procurement":
        df = emissions.calculate_emissions(
            df,
            weight_col=metric_total,
            category_col="category",
            region=region,
        )

    _log_stage("aggregation", report_progress)
    agg_results = aggregation.run_aggregation_pipeline(
        df,
        dm_mapping,
        metric_total=metric_total,
        top_n=top_n_drivers,
        region=region,
    )

    monthly_cat = agg_results["monthly_category_data"]

    _log_stage("emissions_summary", report_progress)
    if mode == "procurement" and "emissions_kg_co2e" in df.columns:
        emissions_summary = emissions.calculate_emissions_summary(df)
        emissions_summary = emissions.calculate_emissions_per_diner_meal(
            emissions_summary,
            diner_meals_in_data,
        )

        if not monthly_cat.empty:
            agg_results["monthly_category_data"] = _attach_monthly_category_emissions(
                monthly_cat, df
            )

    _log_stage("client_metrics_and_diagnostics", report_progress)
    plant_animal_split = calculate_plant_animal_split(df, metric_col=metric_total)
    plant_protein_share = calculate_plant_protein_share(df, metric_col=metric_total)

    findings = checks.run_all_diagnostics(
        df=df,
        diner_meal_mapping=dm_mapping,
        diner_or_meal=diner_or_meal,
        serving=(mode == "serving"),
        metric_total=metric_total,
    )

    return FoodReport(
        rows=df,
        mode=mode,
        region=region,
        diner_or_meal=diner_or_meal,
        diner_meal_mapping=dm_mapping,
        diner_meals_in_data=diner_meals_in_data,
        aggregation=agg_results,
        emissions_summary=emissions_summary,
        plant_animal_split=plant_animal_split,
        plant_protein_share=plant_protein_share,
        findings=tuple(findings),
        summary_stats=_summary_stats(
            df,
            mode=mode,
            region=region,
            diner_or_meal=diner_or_meal,
            diner_meals_in_data=diner_meals_in_data,
            emissions_summary=emissions_summary,
            plant_animal_split=plant_animal_split,
            plant_protein_share=plant_protein_share,
        ),
    )


def _validate_rows(rows: pd.DataFrame, mode: ReportMode) -> None:
    required = required_columns_for_mode(mode)
    missing = [column for column in required if column not in rows.columns]
    if missing:
        raise ValueError(f"Missing required columns: {', '.join(missing)}")
    for column in required:
        null_count = int(rows[column].isna().sum())
        if null_count:
            raise ValueError(f"{column} is missing in {null_count:,} of {len(rows):,} rows")

    metric_total = metric_for_mode(mode)
    if not pd.api.types.is_datetime64_dtype(rows["date"]):
        raise TypeError(f"date must be datetime64, not {rows['date'].dtype}")
    if not pd.api.types.is_numeric_dtype(rows[metric_total]):
        raise TypeError(f"{metric_total} must be numeric, not {rows[metric_total].dtype}")

    negative_count = int((rows[metric_total] < 0).sum())
    if negative_count:
        raise ValueError(f"{metric_total} is negative in {negative_count:,} of {len(rows):,} rows")
    # Exact names: downstream, some steps match categories case-insensitively and others do
    # not, so `beef` would count toward emissions but split from "Beef" in the tables.
    gbd_categories = set(category_names())
    unknown = sorted({str(c) for c in rows["category"].unique() if c not in gbd_categories})
    if unknown:
        raise ValueError(f"Not GBD categories: {', '.join(unknown)}")


@contextmanager
def build_report_charts(report: FoodReport) -> Iterator[ReportCharts]:
    with close_new_figures_on_error():
        figures = report_plots.generate_all_report_plots(
            aggregated_data=report.aggregation,
            diner_meal_mapping=report.diner_meal_mapping,
            emissions_summary=report.emissions_summary,
            metric_total=report.metric_total,
            serving=(report.mode == "serving"),
            plant_animal_split=report.plant_animal_split,
            plant_protein_share=report.plant_protein_share,
            diner_or_meal=report.diner_or_meal,
        )
    try:
        yield ReportCharts(figures=figures)
    finally:
        for _caption, figure in figures:
            plt.close(figure)


def _summary_stats(
    df: pd.DataFrame,
    *,
    mode: ReportMode,
    region: Region,
    diner_or_meal: DinerOrMeal,
    diner_meals_in_data: float,
    emissions_summary: pd.DataFrame | None,
    plant_animal_split: dict[str, Any] | None,
    plant_protein_share: dict[str, Any] | None,
) -> dict[str, str]:
    metric_label_lower = metric_display_label(metric_for_mode(mode)).lower()
    metric_value_unit = "kg" if metric_label_lower == "kilos" else metric_label_lower
    region_summary_label = {
        "europe": "EU/UK",
        "us": "US/Canada",
    }[region]

    summary_stats = {
        "Total rows": f"{len(df):,}",
        "Unique products": f"{df['product'].nunique():,}" if "product" in df.columns else "N/A",
        "Date range": _date_range(df),
        f"Total {diner_or_meal}s": f"{diner_meals_in_data:,.0f}",
        "Data type": mode.title(),
        "Region used for climate emissions factors": region_summary_label,
    }

    if emissions_summary is not None:
        total_co2e = emissions_summary["total_kg_co2e"].sum(min_count=1)
        if pd.notna(total_co2e):
            summary_stats["Total CO2e"] = f"{float(total_co2e):,.0f} kg"
            if diner_meals_in_data > 0:
                summary_stats[f"CO2e per {diner_or_meal}"] = (
                    f"{float(total_co2e) / diner_meals_in_data:.3f} kg"
                )

    if plant_animal_split is not None:
        summary_stats["Plant-based (% of classified food)"] = (
            f"{plant_animal_split['plant_pct']:.1f}%"
        )
        summary_stats["Animal-based (% of classified food)"] = (
            f"{plant_animal_split['animal_pct']:.1f}%"
        )
        summary_stats["Plant-based total"] = (
            f"{plant_animal_split['plant_kg']:,.1f} {metric_value_unit}"
        )
        summary_stats["Animal-based total"] = (
            f"{plant_animal_split['animal_kg']:,.1f} {metric_value_unit}"
        )
    if plant_protein_share is not None:
        summary_stats["Plant protein share (% of protein categories)"] = (
            f"{plant_protein_share['plant_protein_pct']:.1f}%"
        )
        summary_stats["Plant protein total"] = (
            f"{plant_protein_share['plant_protein_total']:,.1f} {metric_value_unit}"
        )
        summary_stats["Protein-category total"] = (
            f"{plant_protein_share['total_protein_metric']:,.1f} {metric_value_unit}"
        )

    return summary_stats


def _attach_monthly_category_emissions(monthly_cat: pd.DataFrame, df: pd.DataFrame) -> pd.DataFrame:
    """Add each (month, category) row's own ``emissions_kg_co2e`` total."""
    # Charts sum this column per month. Joining on month alone would copy the month's total onto
    # every category row, multiplying the charted total by the number of categories.
    keys = ["month_year", "category"]
    category_emissions = (
        df.groupby(keys, dropna=False)["emissions_kg_co2e"].sum(min_count=1).reset_index()
    )
    return monthly_cat.merge(category_emissions, on=keys, how="left", validate="one_to_one")


def _date_range(df: pd.DataFrame) -> str:
    if "date" not in df.columns or not df["date"].notna().any():
        return "N/A"
    first, last = df["date"].min().strftime("%b %Y"), df["date"].max().strftime("%b %Y")
    return first if first == last else f"{first} – {last}"
