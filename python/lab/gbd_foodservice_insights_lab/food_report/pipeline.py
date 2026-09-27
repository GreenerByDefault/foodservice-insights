"""The data scientists' food report: reads a categorized CSV and writes the full bundle.

The report itself is built by the product's `food_report.build_food_report` and
`build_report_charts`, and its two deliverables by `pdf.write_report_pdf` and
`excel.write_client_workbook`. This wrapper adds the file handling around them and the rest of
the bundle, all lab-only: chart PNGs, the QA workbook, the run manifest, the run log, and the
write-back into `client_metadata.json`.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Mapping
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd
from gbd_foodservice_insights.report import diagnostics, excel, pdf
from gbd_foodservice_insights.report.food_report import (
    Finding,
    FoodReport,
    build_food_report,
    build_report_charts,
)
from gbd_foodservice_insights.report.quality import (
    QualityCheckError,
    findings_to_frame,
    missingness_summary_frame,
    summarize_findings,
)
from gbd_foodservice_insights.report.schema import (
    VALID_REPORT_MODES,
    DinerOrMeal,
    ReportMode,
    quality_status_from_findings,
    validate_region,
)

from gbd_foodservice_insights_lab.food_report import artifacts, plots, run_logging
from gbd_foodservice_insights_lab.food_report import diagnostics as qa_diagnostics
from gbd_foodservice_insights_lab.food_report import excel as qa_excel
from gbd_foodservice_insights_lab.food_report.utils import load_diner_meal_mapping_from_json

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
    region = validate_region(region)  # Fails immediately on unrecognised region
    # Everything collected so far, for the failure manifest.
    quality_findings: list[Finding] = []

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

    graph_paths: list[str] = []
    mode_for_manifest = str(requested_mode) if requested_mode is not None else "unknown"

    try:
        mode = _normalize_report_mode(requested_mode)
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
            report_progress=report_progress,
        )
        quality_findings = list(report.findings)

        _log_stage("plot_generation", report_progress)
        with build_report_charts(report) as charts:
            quality_findings.extend(charts.findings)

            _log_stage("plot_export", report_progress)
            graph_paths = plots.export_report_plots(
                charts.figures,
                artifact_paths["graphs_dir"],
            )

            _log_stage("pdf_build", report_progress)
            pdf.write_report_pdf(
                report,
                charts,
                Path(artifact_paths["pdf_path"]),
                client_name=metadata.get("client", input_path.parent.name),
                baseline_pilot=metadata.get("baseline_pilot", "baseline"),
                show_quality_successes=show_quality_successes,
            )

        quality_summary = summarize_findings(quality_findings)
        quality_status = quality_status_from_findings(quality_findings)
        summary_stats = {**report.summary_stats, "Data Quality Status": quality_status.upper()}

        _log_stage("client_workbook_build", report_progress)
        excel.write_client_workbook(report, Path(artifact_paths["client_excel_path"]))

        _log_stage("qa_workbook_build", report_progress)
        artifact_paths["qa_excel_path"] = _write_qa_workbook(
            report,
            artifact_paths["qa_excel_path"],
            quality_findings=quality_findings,
            pdf_extracted=metadata.get("pdf_extracted"),
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
            diagnostics=list(report.diagnostics),
            summary=summary_stats,
            quality_status=quality_status,
            missing_data_findings=quality_findings,
            quality_summary=quality_summary,
            graph_paths=graph_paths,
        )
    except Exception as exc:
        logger.exception("Food report run failed.")
        if isinstance(exc, QualityCheckError):
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


def _write_qa_workbook(
    report: FoodReport,
    path: str,
    *,
    quality_findings: list[Finding],
    pdf_extracted: bool | None,
) -> str:
    df = report.rows
    data_profile_df = None
    try:
        data_profile_df = qa_diagnostics.summarise_numeric_columns(df)
    except Exception as exc:
        logger.warning("Could not compute data profile: %s", exc)

    return qa_excel.build_qa_excel_report(
        output_path=path,
        raw_df=df,
        monthly_product_data=report.aggregation["monthly_product_data"],
        monthly_category_data=report.aggregation["monthly_category_data"],
        template_data=report.aggregation["template_data"],
        highest_lowest=report.aggregation["highest_lowest"],
        diner_meals_df=excel.diner_meals_frame(report),
        emissions_summary=report.emissions_summary,
        animal_emissions_intensity=report.procurement_table("animal_emissions_intensity"),
        decision_kpis=report.procurement_table("decision_kpis"),
        substitution_scenarios=report.procurement_table("substitution_scenarios"),
        quality_findings_df=findings_to_frame(quality_findings),
        missingness_summary_df=missingness_summary_frame(df),
        data_profile_df=data_profile_df,
        diagnostic_sheets=_collect_diagnostic_export_sheets(
            df,
            report.diner_meal_mapping,
            metric_total=report.metric_total,
            monthly_product_data=report.aggregation.get("monthly_product_data"),
            monthly_category_data=report.aggregation.get("monthly_category_data"),
            pdf_extracted=pdf_extracted,
        ),
        diner_or_meal=report.diner_or_meal,
    )


def _normalize_report_mode(value: str | None) -> ReportMode:
    """Normalize arbitrary procurement/serving text into a canonical mode."""
    if value is None:
        return "procurement"

    normalized = str(value).strip().lower()
    if normalized in VALID_REPORT_MODES:
        return normalized

    if "serv" in normalized:
        return "serving"
    return "procurement"
