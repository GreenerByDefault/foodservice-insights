"""The in-memory core of the food report: categorized rows in, report numbers and charts out.

Nothing here reads or writes a file. `pdf.write_report_pdf` and `excel.write_client_workbook`
turn a `FoodReport` into the deliverables; `pipeline.run_food_report` is the file-reading
wrapper that also writes the data scientists' bundle.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Literal

import matplotlib.pyplot as plt
import pandas as pd
from matplotlib.figure import Figure

from gbd_foodservice_insights import emissions
from gbd_foodservice_insights.plotting_utils import close_new_figures_on_error
from gbd_foodservice_insights.report import aggregation, diagnostics, plots
from gbd_foodservice_insights.report.aggregation import (
    calculate_plant_animal_split,
    calculate_plant_protein_share,
)
from gbd_foodservice_insights.report.quality import (
    QualityCheckError,
    check_required_columns,
    check_required_non_null,
    check_row_count_drift,
    compare_missing_snapshots,
    make_finding,
    missing_snapshot,
    raise_on_error_findings,
)
from gbd_foodservice_insights.report.schema import (
    REGION_DAYFIRST,
    DinerOrMeal,
    Region,
    ReportMode,
    metric_display_label,
    metric_for_mode,
    required_columns_for_mode,
    required_non_null_columns_for_mode,
)
from gbd_foodservice_insights.report.utils import (
    compute_month_alignment,
    ensure_month_year_column,
    normalize_diner_meal_mapping,
)

logger = logging.getLogger(__name__)

type Finding = dict[str, Any]

_STAGE_MESSAGES = {
    "ingestion": "Loading the input data.",
    "date_normalization": "Checking and standardizing dates.",
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
    aggregation: dict[str, pd.DataFrame]
    emissions_summary: pd.DataFrame | None
    plant_animal_split: dict[str, Any] | None
    plant_protein_share: dict[str, Any] | None
    diagnostics: tuple[Finding, ...]
    # In the order they were collected, which is the order the PDF lists them in. Chart
    # findings come later, in `ReportCharts.findings`.
    findings: tuple[Finding, ...]
    # Without "Data Quality Status", which depends on the chart findings too.
    summary_stats: dict[str, str]

    @property
    def metric_total(self) -> str:
        return metric_for_mode(self.mode)

    @property
    def total_diner_meals(self) -> float:
        return float(sum(self.diner_meal_mapping.values()))

    def procurement_table(self, name: ProcurementTable) -> pd.DataFrame | None:
        if self.mode != "procurement":
            return None
        table = self.aggregation.get(name)
        return table if isinstance(table, pd.DataFrame) and not table.empty else None


@dataclass(frozen=True)
class ReportCharts:
    """Closed when the `build_report_charts` block exits."""

    figures: list[tuple[str, Figure]]
    findings: tuple[Finding, ...]


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
    pdf_extracted: bool | None = None,
    report_progress: Callable[[], None] = _ignore,
) -> FoodReport:
    """An error finding raises `QualityCheckError`."""
    metric_total = metric_for_mode(mode)
    quality_findings: list[Finding] = []
    df = rows.copy()

    _log_stage("ingestion", report_progress)
    # Ingestion checks (month_year is derived from date by this script, not required as input)
    quality_findings.extend(
        check_required_columns(df, required_columns_for_mode(mode), stage="ingestion")
    )
    quality_findings.extend(
        check_required_non_null(
            df,
            required_non_null_columns_for_mode(mode),
            stage="ingestion",
        )
    )
    raise_on_error_findings(quality_findings)

    # Date normalization with explicit diagnostics
    _log_stage("date_normalization", report_progress)
    dayfirst_preference = REGION_DAYFIRST[region]

    before = missing_snapshot(df)
    before_rows = len(df)
    try:
        df, date_diag = diagnostics.parse_and_validate_date_column(
            df,
            date_col="date",
            allow_missing=True,
            return_diagnostics=True,
            dayfirst_preference=dayfirst_preference,
        )
    except ValueError as exc:
        quality_findings.append(
            make_finding(
                stage="date_normalization",
                category="date_parse_failure",
                status="error",
                message=str(exc),
            )
        )
        raise QualityCheckError(quality_findings) from exc
    status_counts = date_diag["parse_status"].value_counts(dropna=False).to_dict()
    for status, count in status_counts.items():
        if status == "parsed":
            continue
        mapped_status = "warning" if status == "missing" else "error"
        quality_findings.append(
            make_finding(
                stage="date_normalization",
                category="date_parse_status",
                status=mapped_status,
                message=f"Date parsing status '{status}' occurred {int(count)} times.",
                count=int(count),
                metadata={"parse_status": status},
            )
        )
    quality_findings.extend(
        compare_missing_snapshots(before, missing_snapshot(df), stage="date_normalization")
    )
    quality_findings.extend(check_row_count_drift(before_rows, len(df), stage="date_normalization"))

    _log_stage("month_normalization", report_progress)
    before = missing_snapshot(df)
    before_rows = len(df)
    try:
        df = ensure_month_year_column(df, date_col="date", month_col="month_year")
    except ValueError as exc:
        quality_findings.append(
            make_finding(
                stage="month_normalization",
                category="month_year_generation_failed",
                status="error",
                message=str(exc),
            )
        )
        raise QualityCheckError(quality_findings) from exc

    quality_findings.extend(
        compare_missing_snapshots(before, missing_snapshot(df), stage="month_normalization")
    )
    quality_findings.extend(
        check_row_count_drift(before_rows, len(df), stage="month_normalization")
    )

    # Re-check full required schema after normalization
    quality_findings.extend(
        check_required_columns(
            df,
            required_columns_for_mode(mode),
            stage="post_normalization",
        )
    )

    # Re-check required non-null fields after normalization
    quality_findings.extend(
        check_required_non_null(
            df,
            required_non_null_columns_for_mode(mode),
            stage="post_normalization",
        )
    )

    raise_on_error_findings(quality_findings)

    _log_stage("diner_meal_mapping", report_progress)
    try:
        dm_mapping = normalize_diner_meal_mapping(diner_meal_mapping)
    except Exception as exc:
        quality_findings.append(
            make_finding(
                stage="ingestion",
                category="diner_meal_mapping",
                status="error",
                message=f"Could not load diner-meal mapping: {exc}",
            )
        )
        raise QualityCheckError(quality_findings) from exc
    total_dm = float(sum(dm_mapping.values()))

    if "month_year" in df.columns:
        alignment = compute_month_alignment(df["month_year"].dropna().unique(), dm_mapping.keys())
        if alignment["missing_in_mapping"]:
            quality_findings.append(
                make_finding(
                    stage="ingestion",
                    category="diner_meal_alignment",
                    status="warning",
                    message=(
                        "Months in data but missing in diner-meal mapping: "
                        f"{alignment['missing_in_mapping']}"
                    ),
                    count=len(alignment["missing_in_mapping"]),
                )
            )
        if alignment["missing_in_data"]:
            quality_findings.append(
                make_finding(
                    stage="ingestion",
                    category="diner_meal_alignment",
                    status="info",
                    message=(
                        "Months in diner-meal mapping but absent in data: "
                        f"{alignment['missing_in_data']}"
                    ),
                    count=len(alignment["missing_in_data"]),
                )
            )

    _log_stage("emissions", report_progress)
    emissions_summary = None
    if mode == "procurement" and metric_total in df.columns:
        before = missing_snapshot(df)
        before_rows = len(df)
        try:
            df, emissions_findings = emissions.calculate_emissions(
                df,
                weight_col=metric_total,
                category_col="category",
                region=region,
                return_findings=True,
            )
            quality_findings.extend(emissions_findings)
            quality_findings.extend(
                compare_missing_snapshots(before, missing_snapshot(df), stage="emissions")
            )
            quality_findings.extend(check_row_count_drift(before_rows, len(df), stage="emissions"))
            missing_emissions = df[df["emissions_kg_co2e"].isna()].copy()
            if not missing_emissions.empty:
                by_category = (
                    missing_emissions.groupby("category", dropna=False)
                    .size()
                    .sort_values(ascending=False)
                )
                quality_findings.append(
                    make_finding(
                        stage="emissions",
                        category="emissions_missing_by_category",
                        status="warning",
                        message=(f"{len(missing_emissions)} rows have missing emissions values."),
                        column="emissions_kg_co2e",
                        count=len(missing_emissions),
                        metadata={"counts_by_category": by_category.head(10).to_dict()},
                    )
                )

                if "month_year" in missing_emissions.columns:
                    by_month = (
                        missing_emissions.groupby("month_year", dropna=False)
                        .size()
                        .sort_values(ascending=False)
                    )
                    quality_findings.append(
                        make_finding(
                            stage="emissions",
                            category="emissions_missing_by_month",
                            status="warning",
                            message=(f"Missing emissions occur in {by_month.shape[0]} months."),
                            column="emissions_kg_co2e",
                            count=len(missing_emissions),
                            metadata={
                                "counts_by_month": {
                                    str(k): int(v) for k, v in by_month.head(10).items()
                                }
                            },
                        )
                    )
        except Exception as exc:
            quality_findings.append(
                make_finding(
                    stage="emissions",
                    category="emissions_calculation_failed",
                    status="error",
                    message=str(exc),
                )
            )

    _log_stage("aggregation", report_progress)
    try:
        agg_results = aggregation.run_aggregation_pipeline(
            df,
            dm_mapping,
            metric_total=metric_total,
            top_n=top_n_drivers,
            region=region,
        )
    except Exception as exc:
        quality_findings.append(
            make_finding(
                stage="aggregation",
                category="aggregation_failed",
                status="error",
                message=str(exc),
            )
        )
        raise QualityCheckError(quality_findings) from exc

    monthly_cat = agg_results["monthly_category_data"]

    _log_stage("emissions_summary", report_progress)
    if mode == "procurement" and "emissions_kg_co2e" in df.columns:
        try:
            emissions_summary = emissions.calculate_emissions_summary(df)
            emissions_summary = emissions.calculate_emissions_per_diner_meal(
                emissions_summary,
                total_dm,
            )

            if not monthly_cat.empty:
                merged = _attach_monthly_category_emissions(monthly_cat, df)
                agg_results["monthly_category_data"] = merged
                missing_emissions_count = int(merged["emissions_kg_co2e"].isna().sum())
                if missing_emissions_count > 0:
                    quality_findings.append(
                        make_finding(
                            stage="aggregation",
                            category="monthly_emissions_missing",
                            status="warning",
                            message=(
                                f"Monthly category table has {missing_emissions_count} rows "
                                "with missing emissions after merge."
                            ),
                            column="emissions_kg_co2e",
                            count=missing_emissions_count,
                        )
                    )
        except Exception as exc:
            quality_findings.append(
                make_finding(
                    stage="emissions",
                    category="emissions_summary_failed",
                    status="error",
                    message=str(exc),
                )
            )
    _log_stage("client_metrics_and_diagnostics", report_progress)
    plant_animal_split = None
    plant_protein_share = None
    try:
        plant_animal_split = calculate_plant_animal_split(df, metric_col=metric_total)
    except Exception as exc:
        logger.warning("Could not calculate plant/animal split: %s", exc)
    try:
        plant_protein_share = calculate_plant_protein_share(df, metric_col=metric_total)
    except Exception as exc:
        logger.warning("Could not calculate plant protein share: %s", exc)

    diagnostics_list: list[Finding] = []
    try:
        diagnostics_list = diagnostics.run_all_diagnostics(
            df=df,
            diner_meal_mapping=dm_mapping,
            serving=(mode == "serving"),
            monthly_product_data=agg_results.get("monthly_product_data"),
            monthly_category_data=agg_results.get("monthly_category_data"),
            metric_total=metric_total,
            pdf_extracted=pdf_extracted,
        )
        quality_findings.extend(diagnostics_list)
    except Exception as exc:
        quality_findings.append(
            make_finding(
                stage="diagnostics",
                category="diagnostics_failed",
                status="error",
                message=str(exc),
            )
        )

    raise_on_error_findings(quality_findings)

    return FoodReport(
        rows=df,
        mode=mode,
        region=region,
        diner_or_meal=diner_or_meal,
        diner_meal_mapping=dm_mapping,
        aggregation=agg_results,
        emissions_summary=emissions_summary,
        plant_animal_split=plant_animal_split,
        plant_protein_share=plant_protein_share,
        diagnostics=tuple(diagnostics_list),
        findings=tuple(quality_findings),
        summary_stats=_summary_stats(
            df,
            mode=mode,
            region=region,
            diner_or_meal=diner_or_meal,
            total_dm=total_dm,
            emissions_summary=emissions_summary,
            plant_animal_split=plant_animal_split,
            plant_protein_share=plant_protein_share,
        ),
    )


@contextmanager
def build_report_charts(report: FoodReport) -> Iterator[ReportCharts]:
    findings: list[Finding] = []
    with close_new_figures_on_error():
        figures = plots.generate_all_report_plots(
            aggregated_data=report.aggregation,
            diner_meal_mapping=report.diner_meal_mapping,
            emissions_summary=report.emissions_summary,
            metric_total=report.metric_total,
            serving=(report.mode == "serving"),
            quality_findings=findings,
            plant_animal_split=report.plant_animal_split,
            plant_protein_share=report.plant_protein_share,
            diner_or_meal=report.diner_or_meal,
        )
    try:
        yield ReportCharts(figures=figures, findings=tuple(findings))
    finally:
        for _caption, figure in figures:
            plt.close(figure)


def _summary_stats(
    df: pd.DataFrame,
    *,
    mode: ReportMode,
    region: Region,
    diner_or_meal: DinerOrMeal,
    total_dm: float,
    emissions_summary: pd.DataFrame | None,
    plant_animal_split: dict[str, Any] | None,
    plant_protein_share: dict[str, Any] | None,
) -> dict[str, str]:
    metric_label_lower = metric_display_label(metric_for_mode(mode)).lower()
    metric_value_unit = "kg" if metric_label_lower == "kilos" else metric_label_lower
    region_summary_label = {
        "europe": "EU/UK",
        "us": "US/Canada",
    }.get(region, str(region).upper())

    summary_stats = {
        "Total rows": f"{len(df):,}",
        "Unique products": f"{df['product'].nunique():,}" if "product" in df.columns else "N/A",
        "Date range": (
            f"{df['date'].min().strftime('%b %Y')} – {df['date'].max().strftime('%b %Y')}"
            if "date" in df.columns and df["date"].notna().any()
            else "N/A"
        ),
        f"Total {diner_or_meal}s": f"{total_dm:,.0f}",
        "Data type": mode.title(),
        "Region used for climate emissions factors": region_summary_label,
    }

    if emissions_summary is not None:
        total_co2e = emissions_summary["total_kg_co2e"].sum(min_count=1)
        if pd.notna(total_co2e):
            summary_stats["Total CO2e"] = f"{float(total_co2e):,.0f} kg"
            if total_dm > 0:
                summary_stats[f"CO2e per {diner_or_meal}"] = (
                    f"{float(total_co2e) / total_dm:.3f} kg"
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
