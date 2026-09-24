"""Handle the files and metadata produced by a food report run.

This module decides what the output files are called, saves report metadata,
writes the run manifest, and returns the final set of artifact paths.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

MANIFEST_VERSION = 1


def default_report_output_dir(input_file: str | Path) -> Path:
    """Return the default directory for one report run's artifacts.

    Args:
        input_file: Path to the categorized input file the report runs on.

    Returns:
        Directory path under ``<input parent>/outputs/<stem>`` where the stem
        has any leading ``"categorized_"`` prefix removed.
    """
    input_path = Path(input_file).resolve()
    stem = input_path.stem.replace("categorized_", "")
    return input_path.parent / "outputs" / stem


def build_report_artifact_paths(out_dir: str | Path, stem: str) -> dict[str, str]:
    """Return canonical output paths for one food-report run.

    This exists so every output-producing step refers to one shared naming
    scheme rather than rebuilding filenames independently. The current naming
    contract keeps ``food_report_{stem}.xlsx`` as the client workbook for
    backward compatibility, with internal artifacts on sibling filenames.

    Args:
        out_dir: Directory in which artifacts will be written; created if missing.
        stem: Stem used to compose ``food_report_{stem}`` filenames.

    Returns:
        Mapping of artifact key to absolute path. Keys: ``pdf_path``,
        ``client_excel_path``, ``qa_excel_path``, ``log_path``, ``manifest_path``,
        ``graphs_dir``.
    """
    resolved_out_dir = Path(out_dir).resolve()
    resolved_out_dir.mkdir(parents=True, exist_ok=True)
    graphs_dir = (resolved_out_dir / "graphs").resolve()
    graphs_dir.mkdir(parents=True, exist_ok=True)
    base_name = f"food_report_{stem}"

    return {
        "pdf_path": str((resolved_out_dir / f"{base_name}.pdf").resolve()),
        "client_excel_path": str((resolved_out_dir / f"{base_name}.xlsx").resolve()),
        "qa_excel_path": str((resolved_out_dir / f"{base_name}_qa.xlsx").resolve()),
        "log_path": str((resolved_out_dir / f"{base_name}.log").resolve()),
        "manifest_path": str((resolved_out_dir / f"{base_name}_manifest.json").resolve()),
        "graphs_dir": str(graphs_dir),
    }


def _load_metadata_dict(metadata_path: Path) -> dict[str, Any]:
    """Load existing client metadata when present.

    Args:
        metadata_path: Path to a JSON metadata file.

    Returns:
        Parsed metadata dict, or an empty dict if the file is absent or not a JSON object.
    """
    if not metadata_path.exists():
        return {}
    with open(metadata_path) as f:
        loaded = json.load(f)
    return loaded if isinstance(loaded, dict) else {}


def _quality_issue_counts(quality_summary: dict[str, Any] | None) -> dict[str, int]:
    """Normalize quality status counts for metadata and manifest outputs.

    Args:
        quality_summary: Optional summary mapping with a ``"by_status"`` sub-dict.

    Returns:
        Dict with integer counts for keys ``success``, ``info``, ``warning``, ``error``.
    """
    by_status = (quality_summary or {}).get("by_status", {})
    return {
        "success": int(by_status.get("success", 0)),
        "info": int(by_status.get("info", 0)),
        "warning": int(by_status.get("warning", 0)),
        "error": int(by_status.get("error", 0)),
    }


def update_metadata_with_report_outputs(
    metadata_path: Path,
    *,
    artifact_paths: dict[str, str],
    input_file: str,
    quality_status: str,
    quality_summary: dict[str, Any],
    graph_paths: list[str] | None = None,
) -> None:
    """Persist report output paths and summary metrics to client metadata.

    This exists so later notebook/script steps can discover the latest report
    outputs without guessing filenames.

    Args:
        metadata_path: JSON file to update in-place (created if missing).
        artifact_paths: Mapping returned by ``build_report_artifact_paths``.
        input_file: Path of the categorized input file used for the run.
        quality_status: Overall quality status string.
        quality_summary: Quality summary mapping with a ``"by_status"`` sub-dict.
        graph_paths: Optional list of graph image paths produced for the run.
    """
    metadata = _load_metadata_dict(metadata_path)
    issue_counts = _quality_issue_counts(quality_summary)

    metadata["food_report_pdf"] = artifact_paths["pdf_path"]
    metadata["food_report_excel"] = artifact_paths["client_excel_path"]
    metadata["food_report_client_excel"] = artifact_paths["client_excel_path"]
    metadata["food_report_qa_excel"] = artifact_paths["qa_excel_path"]
    metadata["food_report_manifest"] = artifact_paths["manifest_path"]
    metadata["food_report_log"] = artifact_paths["log_path"]
    metadata["food_report_graphs_dir"] = artifact_paths["graphs_dir"]
    metadata["food_report_graph_count"] = len(graph_paths or [])
    metadata["report_input_file"] = str(input_file)
    metadata["report_quality_status"] = quality_status
    metadata["report_missing_data_issue_count"] = issue_counts["warning"] + issue_counts["info"]
    metadata["report_invalid_issue_count"] = issue_counts["error"]
    metadata["last_report_run_timestamp"] = datetime.now().isoformat()

    with open(metadata_path, "w") as f:
        json.dump(metadata, f, indent=2)

    logger.info("Updated client metadata with report outputs at %s", metadata_path)


def write_run_manifest(
    manifest_path: str | Path,
    *,
    run_id: str,
    run_status: str,
    started_at: str,
    completed_at: str,
    input_file: str,
    mode: str,
    region: str,
    diner_or_meal: str,
    artifact_paths: dict[str, str],
    quality_status: str | None = None,
    quality_summary: dict[str, Any] | None = None,
    metadata_context: dict[str, Any] | None = None,
    graph_paths: list[str] | None = None,
    error_message: str | None = None,
) -> str:
    """Write a compact machine-readable run summary for the food report.

    This exists so the web app and internal tooling can inspect run outcomes
    without parsing logs or opening the client artifacts. The manifest is an
    internal run summary, not a client-facing deliverable.

    Args:
        manifest_path: Destination JSON path; resolved to an absolute path.
        run_id: Identifier for this report run.
        run_status: Run status string (e.g. ``"success"``, ``"failed"``).
        started_at: ISO-format start timestamp.
        completed_at: ISO-format completion timestamp.
        input_file: Path of the input file used for the run.
        mode: Report mode (e.g. ``"procurement"`` or ``"serving"``).
        region: Region identifier for the run.
        diner_or_meal: Per-unit label associated with the run.
        artifact_paths: Mapping returned by ``build_report_artifact_paths``.
        quality_status: Optional overall quality status string.
        quality_summary: Optional quality summary mapping with ``"by_status"`` counts.
        metadata_context: Optional client-metadata snapshot used to seed
            ``client_metadata_context`` fields.
        graph_paths: Optional list of graph image paths to record.
        error_message: Optional error message; included only when not ``None``.

    Returns:
        Absolute path of the manifest file that was written.
    """
    manifest_path = str(Path(manifest_path).resolve())
    manifest: dict[str, Any] = {
        "manifest_version": MANIFEST_VERSION,
        "run_id": run_id,
        "run_status": run_status,
        "started_at": started_at,
        "completed_at": completed_at,
        "input_file": str(Path(input_file).resolve()),
        "mode": mode,
        "region": region,
        "diner_or_meal": diner_or_meal,
        "quality_status": quality_status,
        "quality_issue_counts": _quality_issue_counts(quality_summary),
        "outputs": {
            "pdf": artifact_paths["pdf_path"],
            "client_excel": artifact_paths["client_excel_path"],
            "qa_excel": artifact_paths["qa_excel_path"],
            "log": artifact_paths["log_path"],
            "manifest": artifact_paths["manifest_path"],
            "graphs_dir": artifact_paths["graphs_dir"],
            "graphs": list(graph_paths or []),
        },
        "client_metadata_context": {
            "client": (metadata_context or {}).get("client"),
            "baseline_pilot": (metadata_context or {}).get("baseline_pilot"),
            "pdf_extracted": (metadata_context or {}).get("pdf_extracted"),
        },
    }
    if error_message is not None:
        manifest["error_message"] = error_message

    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    logger.info("Run manifest saved to %s", manifest_path)
    return manifest_path


def build_run_result(
    *,
    artifact_paths: dict[str, str],
    run_id: str,
    run_status: str,
    diagnostics: list[dict[str, Any]],
    summary: dict[str, Any],
    quality_status: str,
    missing_data_findings: list[dict[str, Any]],
    quality_summary: dict[str, Any],
    graph_paths: list[str] | None = None,
) -> dict[str, Any]:
    """Assemble the public result payload returned by ``run_food_report``.

    This exists so the orchestration layer can return one stable structure
    while artifact naming and compatibility aliases live in one place. The
    ``excel_path`` alias is intentionally preserved and should continue to
    point at the client workbook unless a deliberate API change is made.

    Args:
        artifact_paths: Mapping returned by ``build_report_artifact_paths``.
        run_id: Identifier for this report run.
        run_status: Run status string (e.g. ``"success"``, ``"failed"``).
        diagnostics: List of diagnostic-finding dicts produced during the run.
        summary: Mapping of summary statistics for the run.
        quality_status: Overall quality status string.
        missing_data_findings: Findings related to missing data, as dicts.
        quality_summary: Quality summary mapping with ``"by_status"`` counts.
        graph_paths: Optional list of graph image paths produced for the run.

    Returns:
        Result-payload dict with stable keys for downstream consumers.
    """
    return {
        "pdf_path": artifact_paths["pdf_path"],
        "excel_path": artifact_paths["client_excel_path"],
        "client_excel_path": artifact_paths["client_excel_path"],
        "qa_excel_path": artifact_paths["qa_excel_path"],
        "manifest_path": artifact_paths["manifest_path"],
        "log_path": artifact_paths["log_path"],
        "graphs_dir": artifact_paths["graphs_dir"],
        "graph_paths": list(graph_paths or []),
        "run_id": run_id,
        "run_status": run_status,
        "diagnostics": diagnostics,
        "summary": summary,
        "quality_status": quality_status,
        "missing_data_findings": missing_data_findings,
        "quality_summary": quality_summary,
    }
