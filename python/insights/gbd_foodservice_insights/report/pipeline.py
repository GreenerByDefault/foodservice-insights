"""Canonical orchestrator for the food report pipeline.

This module should stay orchestration-focused. It coordinates loading,
quality checks, aggregation, plotting, and artifact creation, while delegating
PDF building, workbook building, manifest writing, and per-run logging to
their dedicated report modules.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Mapping
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd

from gbd_foodservice_insights.report import (
    artifacts,
    diagnostics,
    excel,
    pdf,
    plots,
    run_logging,
)
from gbd_foodservice_insights.report.food_report import build_food_report
from gbd_foodservice_insights.report.quality import (
    QualityPolicyError,
    findings_to_frame,
    missingness_summary_frame,
    summarize_findings,
)
from gbd_foodservice_insights.report.schema import (
    DinerOrMeal,
    MissingDataPolicy,
    normalize_report_mode,
    quality_status_from_findings,
    validate_missing_data_policy,
    validate_region,
)
from gbd_foodservice_insights.report.utils import (
    load_diner_meal_mapping_from_json,
)

logger = logging.getLogger(__name__)

_STAGE_MESSAGES = {
    "plot_generation": "Building the report charts.",
    "plot_export": "Saving the chart files.",
    "pdf_build": "Creating the PDF report.",
    "client_workbook_build": "Creating the client workbook.",
    "qa_workbook_build": "Creating the QA workbook.",
    "metadata_update": "Updating client metadata.",
    "manifest_write": "Writing the run manifest.",
}


def _log_stage(stage_key: str, report_progress: Callable[[], None]) -> None:
    """Write a plain-English progress update for the current stage."""
    logger.info("Step: %s", _STAGE_MESSAGES[stage_key])
    report_progress()


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
    diner_meal_mapping: Mapping[Any, Any] | None = None,
    output_dir: str | Path | None = None,
    procurement_serving: str | None = None,
    diner_or_meal: DinerOrMeal = "diner",
    top_n_drivers: int = 5,
    region: str = "us",
    missing_data_policy: MissingDataPolicy = "hard_fail",
    show_quality_successes: bool = True,
    report_progress: Callable[[], None] = lambda: None,
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
        df = pd.read_csv(input_path)
        logger.info("Loaded %d rows from %s", len(df), input_path)

        report = build_food_report(
            df,
            diner_meal_mapping=(
                diner_meal_mapping
                if diner_meal_mapping is not None
                else load_diner_meal_mapping_from_json(diner_meal_file)
            ),
            mode=mode,
            region=region,
            diner_or_meal=diner_or_meal,
            top_n_drivers=top_n_drivers,
            pdf_extracted=metadata.get("pdf_extracted"),
            missing_data_policy=policy,
            report_progress=report_progress,
        )
        quality_findings = list(report.findings)
        diagnostics_list = list(report.diagnostics)

        diagnostic_export_sheets = _collect_diagnostic_export_sheets(
            report.rows,
            report.diner_meal_mapping,
            metric_total=report.metric_total,
            monthly_product_data=report.aggregation.get("monthly_product_data"),
            monthly_category_data=report.aggregation.get("monthly_category_data"),
            pdf_extracted=metadata.get("pdf_extracted"),
        )

        _log_stage("plot_generation", report_progress)
        plot_list = plots.generate_all_report_plots(
            aggregated_data=report.aggregation,
            diner_meal_mapping=report.diner_meal_mapping,
            emissions_summary=report.emissions_summary,
            metric_total=report.metric_total,
            serving=(mode == "serving"),
            quality_findings=quality_findings,
            plant_animal_split=report.plant_animal_split,
            plant_protein_share=report.plant_protein_share,
            diner_or_meal=diner_or_meal,
        )

        _log_stage("plot_export", report_progress)
        graph_paths = plots.export_report_plots(
            plot_list,
            artifact_paths["graphs_dir"],
        )

        summary_stats = dict(report.summary_stats)

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
            candidate = report.aggregation.get("animal_emissions_intensity")
            if isinstance(candidate, pd.DataFrame) and not candidate.empty:
                animal_emissions_intensity = candidate
        decision_kpis = None
        if mode == "procurement":
            candidate = report.aggregation.get("decision_kpis")
            if isinstance(candidate, pd.DataFrame) and not candidate.empty:
                decision_kpis = candidate
        substitution_scenarios = None
        if mode == "procurement":
            candidate = report.aggregation.get("substitution_scenarios")
            if isinstance(candidate, pd.DataFrame) and not candidate.empty:
                substitution_scenarios = candidate

        pdf_tables = {
            "Category Template": _format_category_template_for_pdf(
                report.aggregation["template_data"]
            ),
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

        _log_stage("pdf_build", report_progress)
        # Plain-English executive summary payload. Only built when emissions
        # were computed (procurement runs); legacy/serving runs keep the
        # original key-value summary page.
        exec_narrative = None
        if report.emissions_summary is not None and "total_kg_co2e" in report.emissions_summary:
            _co2e_by_cat = report.emissions_summary.dropna(subset=["total_kg_co2e"])
            _total_co2e = float(_co2e_by_cat["total_kg_co2e"].sum(min_count=1) or 0.0)
            if _total_co2e > 0:
                _top = _co2e_by_cat.nlargest(3, "total_kg_co2e")
                exec_narrative = {
                    "client": title_info.get("client", "this institution"),
                    "period": summary_stats.get("Date range", ""),
                    "total_food_kg": float(report.rows[report.metric_total].sum()),
                    "total_co2e_kg": _total_co2e,
                    "per_dm_kg": (
                        (_total_co2e / report.total_diner_meals)
                        if report.total_diner_meals
                        else None
                    ),
                    "dm_label": diner_or_meal,
                    "plant_pct": (
                        report.plant_animal_split["plant_pct"]
                        if report.plant_animal_split is not None
                        else None
                    ),
                    "animal_pct": (
                        report.plant_animal_split["animal_pct"]
                        if report.plant_animal_split is not None
                        else None
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
                [(period, value) for period, value in report.diner_meal_mapping.items()],
                columns=["month_year", f"{diner_or_meal}s"],
            )
            if report.diner_meal_mapping
            else pd.DataFrame(columns=["month_year", f"{diner_or_meal}s"])
        )

        quality_findings_df = findings_to_frame(quality_findings)
        missingness_summary_df = missingness_summary_frame(report.rows)

        data_profile_df = None
        try:
            data_profile_df = diagnostics.summarise_numeric_columns(report.rows)
        except Exception as exc:
            logger.warning("Could not compute data profile: %s", exc)

        _log_stage("client_workbook_build", report_progress)
        artifact_paths["client_excel_path"] = excel.build_client_excel_report(
            output_path=artifact_paths["client_excel_path"],
            monthly_product_data=report.aggregation["monthly_product_data"],
            monthly_category_data=report.aggregation["monthly_category_data"],
            template_data=report.aggregation["template_data"],
            highest_lowest=report.aggregation["highest_lowest"],
            diner_meals_df=dm_df,
            emissions_summary=report.emissions_summary,
            animal_emissions_intensity=animal_emissions_intensity,
            decision_kpis=decision_kpis,
            substitution_scenarios=substitution_scenarios,
            diner_or_meal=diner_or_meal,
        )

        _log_stage("qa_workbook_build", report_progress)
        artifact_paths["qa_excel_path"] = excel.build_qa_excel_report(
            output_path=artifact_paths["qa_excel_path"],
            raw_df=report.rows,
            monthly_product_data=report.aggregation["monthly_product_data"],
            monthly_category_data=report.aggregation["monthly_category_data"],
            template_data=report.aggregation["template_data"],
            highest_lowest=report.aggregation["highest_lowest"],
            diner_meals_df=dm_df,
            emissions_summary=report.emissions_summary,
            animal_emissions_intensity=animal_emissions_intensity,
            decision_kpis=decision_kpis,
            substitution_scenarios=substitution_scenarios,
            quality_findings_df=quality_findings_df,
            missingness_summary_df=missingness_summary_df,
            data_profile_df=data_profile_df,
            diagnostic_sheets=diagnostic_export_sheets,
            diner_or_meal=diner_or_meal,
        )

        _log_stage("metadata_update", report_progress)
        artifacts.update_metadata_with_report_outputs(
            metadata_path,
            artifact_paths=artifact_paths,
            input_file=str(input_path),
            quality_status=quality_status,
            quality_summary=quality_summary,
            graph_paths=graph_paths,
        )

        _log_stage("manifest_write", report_progress)
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
        if isinstance(exc, QualityPolicyError):
            quality_findings = exc.findings
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
