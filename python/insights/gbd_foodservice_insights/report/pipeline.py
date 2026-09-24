"""Canonical orchestrator for the food report pipeline.

This module should stay orchestration-focused. It coordinates loading,
quality checks, aggregation, plotting, and artifact creation, while delegating
PDF building, workbook building, manifest writing, and per-run logging to
their dedicated report modules.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd

from gbd_foodservice_insights import emissions
from gbd_foodservice_insights.report import (
    aggregation,
    artifacts,
    diagnostics,
    excel,
    pdf,
    plots,
    run_logging,
)
from gbd_foodservice_insights.report.aggregation import (
    calculate_plant_animal_split,
    calculate_plant_protein_share,
)
from gbd_foodservice_insights.report.quality import (
    check_required_columns,
    check_required_non_null,
    check_row_count_drift,
    compare_missing_snapshots,
    enforce_policy_or_raise,
    findings_to_frame,
    make_finding,
    missing_snapshot,
    missingness_summary_frame,
    summarize_findings,
)
from gbd_foodservice_insights.report.schema import (
    REGION_DAYFIRST,
    MissingDataPolicy,
    metric_display_label,
    metric_for_mode,
    normalize_report_mode,
    quality_status_from_findings,
    required_columns_for_mode,
    required_non_null_columns_for_mode,
    validate_missing_data_policy,
    validate_region,
)
from gbd_foodservice_insights.report.utils import compute_month_alignment, ensure_month_year_column
from gbd_foodservice_insights.report.utils import (
    load_diner_meal_mapping_from_json as _load_diner_meal_mapping_from_json,
)
from gbd_foodservice_insights.report.utils import (
    normalize_diner_meal_mapping as _normalize_diner_meal_mapping,
)

logger = logging.getLogger(__name__)

_STAGE_MESSAGES = {
    "ingestion": "Loading the input data.",
    "date_normalization": "Checking and standardizing dates.",
    "month_normalization": "Creating the month summary column.",
    "diner_meal_mapping": "Loading the diner-meal mapping.",
    "emissions": "Calculating emissions values.",
    "aggregation": "Summarizing the data for the report.",
    "emissions_summary": "Preparing the emissions summary tables.",
    "client_metrics_and_diagnostics": "Running report checks and summary metrics.",
    "plot_generation": "Building the report charts.",
    "plot_export": "Saving the chart files.",
    "pdf_build": "Creating the PDF report.",
    "client_workbook_build": "Creating the client workbook.",
    "qa_workbook_build": "Creating the QA workbook.",
    "metadata_update": "Updating client metadata.",
    "manifest_write": "Writing the run manifest.",
}


def _log_stage(stage_key: str) -> None:
    """Write a plain-English progress update for the current stage."""
    logger.info("Step: %s", _STAGE_MESSAGES[stage_key])


def _resolve_input_file(input_file: str | Path | None) -> Path:
    """Resolve input file path with metadata fallback."""
    if input_file is None:
        metadata_path = Path.cwd() / "client_metadata.json"
        if not metadata_path.exists():
            raise FileNotFoundError(
                "No input provided and no client_metadata.json found in current directory."
            )

        with open(metadata_path) as f:
            metadata = json.load(f)

        input_file = metadata.get("report_input_file")
        if not input_file:
            raise ValueError(
                "No input provided and 'report_input_file' is missing from client_metadata.json."
            )

    input_path = Path(input_file).resolve()
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    return input_path


def _resolve_diner_meal_mapping(
    diner_meal_file: str | Path | None,
    diner_meal_mapping: dict[Any, Any] | None,
) -> dict[pd.Period, float]:
    """Resolve diner-meal mapping from inline mapping or JSON file."""
    if diner_meal_mapping is not None:
        return _normalize_diner_meal_mapping(diner_meal_mapping)

    return _load_diner_meal_mapping_from_json(diner_meal_file)


def _build_empty_aggregation(metric_total: str) -> dict[str, Any]:
    """Return empty aggregation payload used when aggregation fails in warn mode."""
    per_dm_col = metric_total.replace(" total", "") + " per diner-meal"
    return {
        "monthly_product_data": pd.DataFrame(
            columns=["month_year", "product", metric_total, per_dm_col]
        ),
        "monthly_category_data": pd.DataFrame(
            columns=["month_year", "category", metric_total, per_dm_col]
        ),
        "template_data": pd.DataFrame(),
        "overall_drivers": pd.DataFrame(columns=["product", metric_total, "percentage"]),
        "category_drivers": pd.DataFrame(
            columns=[
                "category",
                "product",
                metric_total,
                f"{metric_total}_in_category",
                "percentage",
            ]
        ),
        "highest_lowest": pd.DataFrame(columns=["category", "times_higher"]),
        "animal_emissions_intensity": pd.DataFrame(
            columns=["category", metric_total, "total_kg_co2e", "kg_co2e_per_kg_food"]
        ),
        "decision_kpis": pd.DataFrame(
            columns=[
                "KPI",
                "Value",
                "Unit",
                "Denominator",
                "Top products",
                "Top product emissions (kg CO2e)",
                "Total animal emissions (kg CO2e)",
            ]
        ),
        "substitution_scenarios": pd.DataFrame(
            columns=[
                "scenario",
                "substitution_pct",
                "source_categories",
                "replacement_category",
                "baseline_ruminant_weight_kg",
                "baseline_ruminant_emissions_kg_co2e",
                "replaced_weight_kg",
                "remaining_ruminant_weight_kg",
                "replacement_weight_kg",
                "replacement_emission_factor_kg_co2e_per_kg",
                "projected_emissions_kg_co2e",
                "avoidable_kg_co2e",
                "institution_emissions_avoided_pct",
            ]
        ),
    }


def _format_animal_emissions_intensity_for_pdf(dataframe: pd.DataFrame) -> pd.DataFrame:
    """Return a PDF-friendly copy of the animal emissions table."""
    if dataframe.empty:
        return dataframe.copy()

    display_df = dataframe.copy()
    display_df = display_df.rename(
        columns={
            "category": "Category",
            "kilos_total": "Kilos of Food",
            "total_kg_co2e": "Kg CO2e Kg",
            "kg_co2e_per_kg_food": "CO2e Per Kg Food",
        }
    )

    ordered_columns = [
        column
        for column in ["Category", "Kilos of Food", "CO2e Per Kg Food", "Kg CO2e Kg"]
        if column in display_df.columns
    ]
    display_df = display_df[ordered_columns]

    for column in ["Kilos of Food", "Kg CO2e Kg"]:
        if column in display_df.columns:
            display_df[column] = display_df[column].round().astype("Int64")

    if "CO2e Per Kg Food" in display_df.columns:
        display_df["CO2e Per Kg Food"] = display_df["CO2e Per Kg Food"].round(2)

    return display_df


def _format_category_template_for_pdf(dataframe: pd.DataFrame) -> pd.DataFrame:
    """Return a PDF-friendly copy of the category template table."""
    if dataframe.empty:
        return dataframe.copy()

    def _format_label(value: object) -> object:
        if not isinstance(value, str):
            return value
        return value.replace("_", " ").title()

    display_df = dataframe.copy()
    display_df.columns = [_format_label(column) for column in display_df.columns]

    if display_df.index.name is not None:
        display_df.index = display_df.index.rename(_format_label(display_df.index.name))

    return display_df


def _format_decision_kpis_for_pdf(dataframe: pd.DataFrame) -> pd.DataFrame:
    """Return a compact, client-facing version of the decision KPI table."""
    if dataframe.empty:
        return dataframe.copy()

    display_df = dataframe.copy()
    display_df = display_df.rename(
        columns={
            "KPI": "Focus",
            "Value": "Share of Animal Emissions (%)",
            "Top products": "Top Animal Products",
            "Top product emissions (kg CO2e)": "Top Products Kg CO2e",
            "Total animal emissions (kg CO2e)": "Total Animal Kg CO2e",
        }
    )

    keep_columns = [
        "Focus",
        "Share of Animal Emissions (%)",
        "Top Animal Products",
        "Top Products Kg CO2e",
        "Total Animal Kg CO2e",
    ]
    display_df = display_df[[column for column in keep_columns if column in display_df.columns]]

    for column in [
        "Share of Animal Emissions (%)",
        "Top Products Kg CO2e",
        "Total Animal Kg CO2e",
    ]:
        if column in display_df.columns:
            rounded = pd.to_numeric(display_df[column], errors="coerce")
            if column == "Share of Animal Emissions (%)":
                display_df[column] = rounded.round(1)
            else:
                display_df[column] = rounded.round().astype("Int64")

    return display_df


def _format_substitution_scenarios_for_pdf(dataframe: pd.DataFrame) -> pd.DataFrame:
    """Return a narrower substitution-scenarios table for the PDF."""
    if dataframe.empty:
        return dataframe.copy()

    display_df = dataframe.copy()
    keep_columns = [
        "scenario",
        "replaced_weight_kg",
        "projected_emissions_kg_co2e",
        "avoidable_kg_co2e",
        "institution_emissions_avoided_pct",
    ]
    display_df = display_df[[column for column in keep_columns if column in display_df.columns]]
    display_df = display_df.rename(
        columns={
            "scenario": "Scenario",
            "replaced_weight_kg": "Weight Replaced (kg)",
            "projected_emissions_kg_co2e": "Projected Kg CO2e",
            "avoidable_kg_co2e": "Avoidable Kg CO2e",
            "institution_emissions_avoided_pct": "Institution Emissions Averted (%)",
        }
    )

    for column in [
        "Weight Replaced (kg)",
        "Projected Kg CO2e",
        "Avoidable Kg CO2e",
        "Institution Emissions Averted (%)",
    ]:
        if column in display_df.columns:
            numeric = pd.to_numeric(display_df[column], errors="coerce")
            if column == "Institution Emissions Averted (%)":
                display_df[column] = numeric.round(2)
            else:
                display_df[column] = numeric.round().astype("Int64")

    return display_df


def _collect_diagnostic_export_sheets(
    df: pd.DataFrame,
    diner_meal_mapping: dict[Any, Any],
    *,
    metric_total: str,
    monthly_product_data: pd.DataFrame | None = None,
    monthly_category_data: pd.DataFrame | None = None,
    pdf_extracted: bool | None = None,
) -> dict[str, pd.DataFrame]:
    """Collect export-ready diagnostic tables for the QA workbook.

    This exists so QA-only tabs are gathered in one place and the main
    orchestration function does not have to manage that bookkeeping inline.
    """
    diagnostic_export_sheets: dict[str, pd.DataFrame] = {}

    try:
        _, numeric_coercion_loss_df = diagnostics.detect_numeric_coercion_loss(
            df,
            [metric_total],
        )
        if not numeric_coercion_loss_df.empty:
            diagnostic_export_sheets["Numeric_Coercion_Loss"] = numeric_coercion_loss_df
    except Exception as exc:
        logger.warning("Could not build numeric coercion loss export: %s", exc)

    try:
        _, potential_name_splits_df = diagnostics.detect_near_duplicate_product_names(
            df,
            metric_total=metric_total,
            pdf_extracted=pdf_extracted,
        )
        if not potential_name_splits_df.empty:
            diagnostic_export_sheets["Potential_Name_Splits"] = potential_name_splits_df
    except Exception as exc:
        logger.warning("Could not build potential name splits export: %s", exc)

    try:
        _, outlier_line_items_df = diagnostics.detect_unusual_sales(
            df,
            summary_col=metric_total,
            product_name_col="product",
            category_col="category",
            return_details=True,
        )
        if not outlier_line_items_df.empty:
            diagnostic_export_sheets["Outlier_Line_Items"] = outlier_line_items_df
    except Exception as exc:
        logger.warning("Could not build outlier line items export: %s", exc)

    try:
        _, category_discontinuity_df = diagnostics.detect_category_discontinuity(
            df,
            metric_total=metric_total,
        )
        if not category_discontinuity_df.empty:
            diagnostic_export_sheets["Category_Discontinuity"] = category_discontinuity_df
    except Exception as exc:
        logger.warning("Could not build category discontinuity export: %s", exc)

    try:
        _, denominator_qc_df = diagnostics.check_diner_meal_reasonableness(diner_meal_mapping)
        if not denominator_qc_df.empty:
            diagnostic_export_sheets["Denominator_QC"] = denominator_qc_df
    except Exception as exc:
        logger.warning("Could not build denominator QC export: %s", exc)

    if monthly_product_data is not None and monthly_category_data is not None:
        try:
            _, aggregation_reconciliation_df = diagnostics.check_aggregation_reconciliation(
                df,
                monthly_product_data,
                monthly_category_data,
                metric_total,
            )
            if not aggregation_reconciliation_df.empty:
                diagnostic_export_sheets["Aggregation_Reconciliation"] = (
                    aggregation_reconciliation_df
                )
        except Exception as exc:
            logger.warning("Could not build aggregation reconciliation export: %s", exc)

    return diagnostic_export_sheets


def run_food_report(
    input_file: str | Path | None = None,
    diner_meal_file: str | Path | None = None,
    diner_meal_mapping: dict[Any, Any] | None = None,
    output_dir: str | Path | None = None,
    procurement_serving: str | None = None,
    diner_or_meal: str = "diner",
    top_n_drivers: int = 5,
    region: str = "us",
    missing_data_policy: MissingDataPolicy = "hard_fail",
    show_quality_successes: bool = True,
) -> dict[str, Any]:
    """Run the full food-report pipeline with explicit quality auditing.

    This is the canonical public entry point for generating the report bundle.
    The returned artifact contract is:

    - ``pdf_path``: client-facing PDF
    - ``client_excel_path``: client-facing workbook
    - ``qa_excel_path``: internal QA workbook
    - ``graphs_dir``: folder containing exported chart image files
    - ``graph_paths``: individual exported chart image paths
    - ``manifest_path``: internal machine-readable run summary
    - ``log_path``: internal per-run debug log

    For backward compatibility, ``excel_path`` is kept and points to the same
    file as ``client_excel_path``.

    Returns
    -------
    dict
        Includes client PDF, client workbook, QA workbook, exported chart
        paths, manifest, log path, and the quality payload used by the
        report and UI layers.
    """
    policy = validate_missing_data_policy(missing_data_policy)
    region = validate_region(region)  # Fails immediately on unrecognised region
    quality_findings: list[dict[str, Any]] = []

    input_path = _resolve_input_file(input_file)
    metadata_path = input_path.parent / "client_metadata.json"
    metadata: dict[str, Any] = {}
    if metadata_path.exists():
        with open(metadata_path) as f:
            metadata = json.load(f)

    requested_mode = procurement_serving or metadata.get("procurement_serving")
    stem = input_path.stem.replace("categorized_", "")
    out_dir = (
        Path(output_dir).resolve()
        if output_dir
        else artifacts.default_report_output_dir(input_path)
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    artifact_paths = artifacts.build_report_artifact_paths(out_dir, stem)
    started_at = datetime.now().isoformat()
    run_id = f"{datetime.now().strftime('%Y%m%dT%H%M%S%f')}_{stem}"
    log_handler_state = run_logging.attach_report_run_file_handler(artifact_paths["log_path"])

    logger.info("Food report run started.")
    logger.info("Run ID: %s", run_id)
    logger.info("Input file: %s", input_path)
    logger.info("Saving report files in: %s", out_dir)
    logger.info("Planned output files:")
    logger.info("  PDF report: %s", artifact_paths["pdf_path"])
    logger.info("  Client workbook: %s", artifact_paths["client_excel_path"])
    logger.info("  QA workbook: %s", artifact_paths["qa_excel_path"])
    logger.info("  Graphs folder: %s", artifact_paths["graphs_dir"])
    logger.info("  Run log: %s", artifact_paths["log_path"])
    logger.info("  Run manifest: %s", artifact_paths["manifest_path"])

    diagnostics_list: list[dict[str, Any]] = []
    summary_stats: dict[str, Any] = {}
    quality_status: str | None = None
    quality_summary: dict[str, Any] | None = None
    graph_paths: list[str] = []
    mode_for_manifest = str(requested_mode) if requested_mode is not None else "unknown"

    try:
        mode = normalize_report_mode(requested_mode)
        mode_for_manifest = mode
        metric_total = metric_for_mode(mode)

        _log_stage("ingestion")
        df = pd.read_csv(input_path)
        logger.info("Loaded %d rows from %s", len(df), input_path)

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
        enforce_policy_or_raise(policy, quality_findings)

        # Date normalization with explicit diagnostics
        _log_stage("date_normalization")
        dayfirst_preference = REGION_DAYFIRST[region]

        if "date" in df.columns:
            before = missing_snapshot(df)
            before_rows = len(df)
            try:
                parsed_df, date_diag = diagnostics.parse_and_validate_date_column(
                    df,
                    date_col="date",
                    allow_missing=True,
                    return_diagnostics=True,
                    dayfirst_preference=dayfirst_preference,
                )
                df = parsed_df
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
            except ValueError as exc:
                quality_findings.append(
                    make_finding(
                        stage="date_normalization",
                        category="date_parse_failure",
                        status="error",
                        message=str(exc),
                    )
                )
                original = df["date"].copy()
                df["date"] = pd.to_datetime(df["date"], errors="coerce")
                coerced_to_missing = int((original.notna() & df["date"].isna()).sum())
                if coerced_to_missing > 0:
                    quality_findings.append(
                        make_finding(
                            stage="date_normalization",
                            category="date_coerce_missing",
                            status="error",
                            message=(
                                f"Fallback parsing coerced {coerced_to_missing} non-missing "
                                "date values to missing."
                            ),
                            column="date",
                            count=coerced_to_missing,
                        )
                    )

            quality_findings.extend(
                compare_missing_snapshots(before, missing_snapshot(df), stage="date_normalization")
            )
            quality_findings.extend(
                check_row_count_drift(before_rows, len(df), stage="date_normalization")
            )
        else:
            quality_findings.append(
                make_finding(
                    stage="date_normalization",
                    category="missing_date_column",
                    status="error",
                    message="Column 'date' is missing and cannot be normalized.",
                )
            )

        _log_stage("month_normalization")
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
            if "month_year" not in df.columns:
                df["month_year"] = pd.NA

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

        enforce_policy_or_raise(policy, quality_findings)

        _log_stage("diner_meal_mapping")
        try:
            dm_mapping = _resolve_diner_meal_mapping(diner_meal_file, diner_meal_mapping)
        except Exception as exc:
            quality_findings.append(
                make_finding(
                    stage="ingestion",
                    category="diner_meal_mapping",
                    status="error",
                    message=f"Could not load diner-meal mapping: {exc}",
                )
            )
            if policy == "hard_fail":
                enforce_policy_or_raise(policy, quality_findings)
            dm_mapping = {}

        if dm_mapping and "month_year" in df.columns:
            alignment = compute_month_alignment(
                df["month_year"].dropna().unique(), dm_mapping.keys()
            )
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

        _log_stage("emissions")
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
                quality_findings.extend(
                    check_row_count_drift(before_rows, len(df), stage="emissions")
                )
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
                            message=(
                                f"{len(missing_emissions)} rows have missing emissions values."
                            ),
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

        _log_stage("aggregation")
        if dm_mapping:
            try:
                agg_results = aggregation.run_aggregation_pipeline(
                    df,
                    dm_mapping,
                    metric_total=metric_total,
                    top_n=top_n_drivers,
                    strict_diner_meal_coverage=(policy == "hard_fail"),
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
                if policy == "hard_fail":
                    enforce_policy_or_raise(policy, quality_findings)
                agg_results = _build_empty_aggregation(metric_total)
        else:
            agg_results = _build_empty_aggregation(metric_total)

        monthly_cat = agg_results["monthly_category_data"]

        _log_stage("emissions_summary")
        if mode == "procurement" and "emissions_kg_co2e" in df.columns:
            try:
                emissions_summary = emissions.calculate_emissions_summary(df)
                total_dm = float(sum(dm_mapping.values())) if dm_mapping else 0.0
                emissions_summary = emissions.calculate_emissions_per_diner_meal(
                    emissions_summary,
                    total_dm,
                )

                if not monthly_cat.empty:
                    monthly_emissions = (
                        df.groupby("month_year", dropna=False)["emissions_kg_co2e"]
                        .sum(min_count=1)
                        .reset_index()
                    )
                    merged = monthly_cat.merge(monthly_emissions, on="month_year", how="left")
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
        _log_stage("client_metrics_and_diagnostics")
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

        try:
            diagnostics_list = diagnostics.run_all_diagnostics(
                df=df,
                diner_meal_mapping=dm_mapping,
                serving=(mode == "serving"),
                monthly_product_data=agg_results.get("monthly_product_data"),
                monthly_category_data=agg_results.get("monthly_category_data"),
                metric_total=metric_total,
                pdf_extracted=metadata.get("pdf_extracted"),
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

        diagnostic_export_sheets = _collect_diagnostic_export_sheets(
            df,
            dm_mapping,
            metric_total=metric_total,
            monthly_product_data=agg_results.get("monthly_product_data"),
            monthly_category_data=agg_results.get("monthly_category_data"),
            pdf_extracted=metadata.get("pdf_extracted"),
        )

        enforce_policy_or_raise(policy, quality_findings)

        _log_stage("plot_generation")
        plot_list = plots.generate_all_report_plots(
            aggregated_data=agg_results,
            diner_meal_mapping=dm_mapping,
            emissions_summary=emissions_summary,
            metric_total=metric_total,
            serving=(mode == "serving"),
            quality_findings=quality_findings,
            plant_animal_split=plant_animal_split,
            plant_protein_share=plant_protein_share,
            diner_or_meal=diner_or_meal,
        )

        _log_stage("plot_export")
        graph_paths = plots.export_report_plots(
            plot_list,
            artifact_paths["graphs_dir"],
        )

        total_dm = float(sum(dm_mapping.values())) if dm_mapping else 0.0
        metric_label = metric_display_label(metric_total)
        metric_label_lower = metric_label.lower()
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

        quality_summary = summarize_findings(quality_findings)
        quality_status = quality_status_from_findings(quality_findings)
        summary_stats["Data Quality Status"] = quality_status.upper()

        title_info = {
            "client": metadata.get("client", input_path.parent.name),
            "baseline_pilot": metadata.get("baseline_pilot", "baseline"),
            "procurement_serving": mode,
        }
        animal_emissions_intensity = None
        if mode == "procurement":
            candidate = agg_results.get("animal_emissions_intensity")
            if isinstance(candidate, pd.DataFrame) and not candidate.empty:
                animal_emissions_intensity = candidate
        decision_kpis = None
        if mode == "procurement":
            candidate = agg_results.get("decision_kpis")
            if isinstance(candidate, pd.DataFrame) and not candidate.empty:
                decision_kpis = candidate
        substitution_scenarios = None
        if mode == "procurement":
            candidate = agg_results.get("substitution_scenarios")
            if isinstance(candidate, pd.DataFrame) and not candidate.empty:
                substitution_scenarios = candidate

        pdf_tables = {
            "Category Template": _format_category_template_for_pdf(agg_results["template_data"]),
        }
        if animal_emissions_intensity is not None:
            pdf_tables["Animal Emissions Intensity"] = _format_animal_emissions_intensity_for_pdf(
                animal_emissions_intensity
            )
        if decision_kpis is not None:
            pdf_tables["Decision KPIs"] = _format_decision_kpis_for_pdf(decision_kpis)
        if substitution_scenarios is not None:
            pdf_tables["Substitution Scenarios"] = _format_substitution_scenarios_for_pdf(
                substitution_scenarios
            )

        _log_stage("pdf_build")
        # Plain-English executive summary payload. Only built when emissions
        # were computed (procurement runs); legacy/serving runs keep the
        # original key-value summary page.
        exec_narrative = None
        if emissions_summary is not None and "total_kg_co2e" in emissions_summary:
            _co2e_by_cat = emissions_summary.dropna(subset=["total_kg_co2e"])
            _total_co2e = float(_co2e_by_cat["total_kg_co2e"].sum(min_count=1) or 0.0)
            if _total_co2e > 0:
                _top = _co2e_by_cat.nlargest(3, "total_kg_co2e")
                exec_narrative = {
                    "client": title_info.get("client", "this institution"),
                    "period": summary_stats.get("Date range", ""),
                    "total_food_kg": float(df[metric_total].sum()),
                    "total_co2e_kg": _total_co2e,
                    "per_dm_kg": (_total_co2e / total_dm) if total_dm else None,
                    "dm_label": diner_or_meal,
                    "plant_pct": (
                        plant_animal_split["plant_pct"] if plant_animal_split is not None else None
                    ),
                    "animal_pct": (
                        plant_animal_split["animal_pct"] if plant_animal_split is not None else None
                    ),
                    "top_categories": [
                        (str(row["category"]), 100 * row["total_kg_co2e"] / _total_co2e)
                        for _, row in _top.iterrows()
                    ],
                    "quality_status": quality_status,
                }

        artifact_paths["pdf_path"] = pdf.build_pdf_report(
            output_path=artifact_paths["pdf_path"],
            title_info=title_info,
            plots=plot_list,
            tables=pdf_tables,
            summary_stats=summary_stats,
            quality_status=quality_status,
            quality_summary=quality_summary,
            missing_data_findings=quality_findings,
            show_quality_successes=show_quality_successes,
            diner_or_meal=diner_or_meal,
            narrative=exec_narrative,
        )

        dm_df = (
            pd.DataFrame(
                [(period, value) for period, value in dm_mapping.items()],
                columns=["month_year", f"{diner_or_meal}s"],
            )
            if dm_mapping
            else pd.DataFrame(columns=["month_year", f"{diner_or_meal}s"])
        )

        quality_findings_df = findings_to_frame(quality_findings)
        missingness_summary_df = missingness_summary_frame(df)

        data_profile_df = None
        try:
            data_profile_df = diagnostics.summarise_numeric_columns(df)
        except Exception as exc:
            logger.warning("Could not compute data profile: %s", exc)

        _log_stage("client_workbook_build")
        artifact_paths["client_excel_path"] = excel.build_client_excel_report(
            output_path=artifact_paths["client_excel_path"],
            monthly_product_data=agg_results["monthly_product_data"],
            monthly_category_data=agg_results["monthly_category_data"],
            template_data=agg_results["template_data"],
            highest_lowest=agg_results["highest_lowest"],
            diner_meals_df=dm_df,
            emissions_summary=emissions_summary,
            animal_emissions_intensity=animal_emissions_intensity,
            decision_kpis=decision_kpis,
            substitution_scenarios=substitution_scenarios,
            diner_or_meal=diner_or_meal,
        )

        _log_stage("qa_workbook_build")
        artifact_paths["qa_excel_path"] = excel.build_qa_excel_report(
            output_path=artifact_paths["qa_excel_path"],
            raw_df=df,
            monthly_product_data=agg_results["monthly_product_data"],
            monthly_category_data=agg_results["monthly_category_data"],
            template_data=agg_results["template_data"],
            highest_lowest=agg_results["highest_lowest"],
            diner_meals_df=dm_df,
            emissions_summary=emissions_summary,
            animal_emissions_intensity=animal_emissions_intensity,
            decision_kpis=decision_kpis,
            substitution_scenarios=substitution_scenarios,
            quality_findings_df=quality_findings_df,
            missingness_summary_df=missingness_summary_df,
            data_profile_df=data_profile_df,
            diagnostic_sheets=diagnostic_export_sheets,
            diner_or_meal=diner_or_meal,
        )

        _log_stage("metadata_update")
        artifacts.update_metadata_with_report_outputs(
            metadata_path,
            artifact_paths=artifact_paths,
            input_file=str(input_path),
            quality_status=quality_status,
            quality_summary=quality_summary,
            graph_paths=graph_paths,
        )

        _log_stage("manifest_write")
        artifact_paths["manifest_path"] = artifacts.write_run_manifest(
            artifact_paths["manifest_path"],
            run_id=run_id,
            run_status="success",
            started_at=started_at,
            completed_at=datetime.now().isoformat(),
            input_file=str(input_path),
            mode=mode,
            region=region,
            diner_or_meal=diner_or_meal,
            artifact_paths=artifact_paths,
            quality_status=quality_status,
            quality_summary=quality_summary,
            metadata_context=metadata,
            graph_paths=graph_paths,
        )

        logger.info("Food report run finished successfully.")
        return artifacts.build_run_result(
            artifact_paths=artifact_paths,
            run_id=run_id,
            run_status="success",
            diagnostics=diagnostics_list,
            summary=summary_stats,
            quality_status=quality_status,
            missing_data_findings=quality_findings,
            quality_summary=quality_summary,
            graph_paths=graph_paths,
        )
    except Exception as exc:
        logger.exception("Food report run failed.")
        failure_quality_summary = summarize_findings(quality_findings) if quality_findings else None
        failure_quality_status = (
            quality_status_from_findings(quality_findings) if quality_findings else None
        )
        try:
            artifact_paths["manifest_path"] = artifacts.write_run_manifest(
                artifact_paths["manifest_path"],
                run_id=run_id,
                run_status="failed",
                started_at=started_at,
                completed_at=datetime.now().isoformat(),
                input_file=str(input_path),
                mode=mode_for_manifest,
                region=region,
                diner_or_meal=diner_or_meal,
                artifact_paths=artifact_paths,
                quality_status=failure_quality_status,
                quality_summary=failure_quality_summary,
                metadata_context=metadata,
                graph_paths=graph_paths,
                error_message=str(exc),
            )
        except Exception:
            logger.exception("Could not write the failure manifest.")
        raise
    finally:
        logger.info("Closing the report run log.")
        run_logging.close_report_run_file_handler(log_handler_state)


# Backward-compatible wrappers for previous direct imports.
def normalize_diner_meal_mapping(raw_mapping: dict[Any, Any]) -> dict[pd.Period, float]:
    """Compatibility wrapper. Prefer
    ``gbd_foodservice_insights.report.utils.normalize_diner_meal_mapping``.
    """
    return _normalize_diner_meal_mapping(raw_mapping)


def load_diner_meal_mapping_from_json(diner_meal_file: str | Path | None) -> dict[pd.Period, float]:
    """Compatibility wrapper. Prefer
    ``gbd_foodservice_insights.report.utils.load_diner_meal_mapping_from_json``.
    """
    return _load_diner_meal_mapping_from_json(diner_meal_file)
