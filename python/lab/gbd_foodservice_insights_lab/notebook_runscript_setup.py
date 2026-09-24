from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, cast

import pandas as pd
from gbd_foodservice_insights.llm import setup_api_clients
from gbd_foodservice_insights.report import artifacts as report_artifacts

from gbd_foodservice_insights_lab import PACKAGE_DIR

logger = logging.getLogger(__name__)

ANALYSIS_CONTEXT_ENV_VAR = "GBD_ANALYSIS_CONTEXT"

AnalysisContext = Literal["baseline", "pilot", "web_app"]
PipelineStep = Literal[
    "prepare_tabular",
    "prepare_pdf",
    "categorize",
    "clean_units",
    "produce_food_report",
    "pilot",
]

VALID_ANALYSIS_CONTEXTS: tuple[str, ...] = ("baseline", "pilot", "web_app")
VALID_STEPS: tuple[str, ...] = (
    "prepare_tabular",
    "prepare_pdf",
    "categorize",
    "clean_units",
    "produce_food_report",
    "pilot",
)
VALID_PROCUREMENT_SERVING: tuple[str, ...] = (
    "purchasing-procurement data",
    "sales-serving data",
)


def get_customer_template_dir() -> Path:
    """Return the runscripts folder next to the installed lab package."""
    template_dir = PACKAGE_DIR.parent / "runscripts"
    if not template_dir.exists():
        raise FileNotFoundError(
            "Could not find the runscripts folder next to the installed GBD "
            f"package. Expected it at: {template_dir}"
        )
    return template_dir


def setup_pandas_display() -> None:
    """Configure pandas display options for better notebook output."""
    pd.set_option("display.max_columns", None)
    pd.set_option("display.width", None)


def _to_json_serializable(value: Any) -> Any:
    """
    Make values safe to save in JSON metadata files.

    This exists because pipeline metadata can include values like paths,
    timestamps, pandas values, and numpy numbers that JSON cannot save directly.
    We convert them into simple values (text, numbers, lists, or null) so
    metadata updates do not fail mid-run.
    """
    if isinstance(value, dict):
        return {str(k): _to_json_serializable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_to_json_serializable(v) for v in value]
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if value is pd.NA:
        return None

    # Convert numpy/pandas scalar types (e.g., np.int64, np.float64) to Python scalars.
    value_module = type(value).__module__
    if value_module.startswith(("numpy", "pandas")) and hasattr(value, "item"):
        try:
            return value.item()
        except TypeError, ValueError:
            pass

    return value


def _normalize_analysis_context(
    value: str | None,
    *,
    source: str,
) -> AnalysisContext | None:
    """Normalize and validate an analysis context."""
    if value is None:
        return None

    normalized = value.strip().lower()
    if normalized not in VALID_ANALYSIS_CONTEXTS:
        raise ValueError(
            f"Invalid analysis context from {source}: {value!r}. Expected one of: "
            f"{', '.join(VALID_ANALYSIS_CONTEXTS)}."
        )
    return cast(AnalysisContext, normalized)


def _resolve_analysis_context(
    analysis_context: AnalysisContext | None = None,
    path_parts: tuple[str, ...] | None = None,
) -> AnalysisContext:
    """
    Resolve analysis context using strict precedence:
    1) explicit function arg
    2) env var GBD_ANALYSIS_CONTEXT
    3) folder inference for baseline/pilot
    """
    explicit = _normalize_analysis_context(analysis_context, source="function argument")
    if explicit is not None:
        return explicit

    env_value = _normalize_analysis_context(
        os.getenv(ANALYSIS_CONTEXT_ENV_VAR),
        source=ANALYSIS_CONTEXT_ENV_VAR,
    )
    if env_value is not None:
        return env_value

    if path_parts:
        for part in reversed(path_parts):
            lowered = part.strip().lower()
            if lowered in {"baseline", "pilot"}:
                return cast(AnalysisContext, lowered)

    raise ValueError(
        "Could not infer analysis context. Set `analysis_context` explicitly or set "
        "`GBD_ANALYSIS_CONTEXT`."
    )


def _validate_step(step: str | None) -> None:
    """Validate a pipeline step value."""
    if step is None:
        return
    if step not in VALID_STEPS:
        raise ValueError(f"Invalid step: {step!r}. Expected one of: {', '.join(VALID_STEPS)}.")


def _with_suffix(input_file: str, suffix: str) -> str:
    """Append suffix to filename stem while preserving extension."""
    input_path = Path(input_file)
    return str(input_path.with_stem(input_path.stem + suffix))


def _build_filename_base(config: dict[str, Any]) -> str:
    """Construct filename base from config keys."""
    client = config["client"]
    analysis_context = config["analysis_context"]
    procurement_serving = config["procurement_serving"]
    sub_client_name = config.get("sub_client_name")

    if sub_client_name:
        return f"{client}_{sub_client_name}_{analysis_context}_{procurement_serving}"
    return f"{client}_{analysis_context}_{procurement_serving}"


def _load_existing_metadata(base_filepath: str | Path) -> dict[str, Any]:
    """Load existing metadata if present, otherwise return empty dict."""
    metadata_path = Path(base_filepath) / "client_metadata.json"
    if not metadata_path.exists():
        return {}
    with open(metadata_path) as f:
        try:
            return json.load(f)
        # Catch JSON parsing errors to avoid crashing if the file is corrupted, which has
        # happened before.
        except json.JSONDecodeError as e:
            import warnings

            warnings.warn(
                (
                    f"client_metadata.json is corrupted and could not be parsed ({e}). "
                    f"Starting with empty metadata. You may want to delete or fix: "
                    f"{metadata_path}"
                ),
                stacklevel=3,
            )
            return {}


def _apply_step_file_paths(
    config: dict[str, Any],
    step: PipelineStep | None,
    *,
    metadata: dict[str, Any] | None = None,
) -> None:
    """
    Attach step-specific file paths to config.

    This is shared by detect_client_structure() and load_client_metadata().
    """
    metadata = metadata or {}
    for key in (
        "input_file",
        "output_file",
        "excel_output_file",
        "pdf_output_file",
        "baseline_input_file",
        "pilot_input_file",
    ):
        config.pop(key, None)

    if step is None:
        return

    base_filepath = str(config["base_filepath"])
    filename_base = _build_filename_base(config)
    extracted_output = f"{base_filepath}/extracted_{filename_base}.csv"
    categorized_output = f"{base_filepath}/extracted_{filename_base}_categorized.csv"

    if step in {"prepare_tabular", "prepare_pdf"}:
        config["output_file"] = extracted_output
        return

    if step == "categorize":
        config["input_file"] = extracted_output
        config["output_file"] = categorized_output
        return

    if step == "clean_units":
        categorized_input = (
            metadata.get("categorized_output_file")
            or metadata.get("categorization_stats", {}).get("output_file")
            or categorized_output
        )
        config["input_file"] = categorized_input
        config["output_file"] = _with_suffix(categorized_input, "_units_cleaned")
        return

    if step == "produce_food_report":
        clean_units_default = _with_suffix(categorized_output, "_units_cleaned")
        report_input = metadata.get("report_input_file")
        if not report_input:
            report_input = (
                clean_units_default if Path(clean_units_default).exists() else categorized_output
            )
        stem = Path(report_input).stem.replace("categorized_", "")
        default_output_dir = report_artifacts.default_report_output_dir(report_input)
        excel_output_file = str(default_output_dir / f"food_report_{stem}.xlsx")
        pdf_output_file = str(default_output_dir / f"food_report_{stem}.pdf")

        config["input_file"] = report_input
        config["excel_output_file"] = excel_output_file
        config["pdf_output_file"] = pdf_output_file
        # Keep legacy key for compatibility with old notebook code
        config["output_file"] = excel_output_file
        return

    if step == "pilot":
        if config["analysis_context"] != "pilot":
            raise ValueError(
                "pilot step requires pilot context. Current context is "
                f"{config['analysis_context']!r}."
            )

        has_sub_client = config["sub_client_name"] is not None
        client = config["client"]
        procurement_serving = config["procurement_serving"]
        sub_client_name = config["sub_client_name"]
        base_filepath = str(config["base_filepath"])
        baseline_base_filepath = base_filepath.replace("/pilot/", "/baseline/")

        if has_sub_client:
            baseline_filename_base = f"{client}_{sub_client_name}_baseline_{procurement_serving}"
            pilot_filename_base = f"{client}_{sub_client_name}_pilot_{procurement_serving}"
        else:
            baseline_filename_base = f"{client}_baseline_{procurement_serving}"
            pilot_filename_base = f"{client}_pilot_{procurement_serving}"

        config["baseline_input_file"] = (
            f"{baseline_base_filepath}/full_analysed_{baseline_filename_base}.xlsx"
        )
        config["pilot_input_file"] = f"{base_filepath}/full_analysed_{pilot_filename_base}.xlsx"
        return

    raise ValueError(f"Unhandled step: {step!r}")


def _validate_required_input_files(config: dict[str, Any], step: PipelineStep | None) -> None:
    """Fail loudly if a step expects upstream files that do not exist."""
    if step in {"categorize", "clean_units", "produce_food_report"}:
        input_file = Path(str(config["input_file"]))
        if not input_file.exists():
            raise FileNotFoundError(
                f"Required input file for step '{step}' not found: {input_file}"
            )
    elif step == "pilot":
        baseline_input = Path(str(config["baseline_input_file"]))
        pilot_input = Path(str(config["pilot_input_file"]))
        if not baseline_input.exists():
            raise FileNotFoundError(
                f"Required baseline input file for step '{step}' not found: {baseline_input}"
            )
        if not pilot_input.exists():
            raise FileNotFoundError(
                f"Required pilot input file for step '{step}' not found: {pilot_input}"
            )


def _print_configuration(config: dict[str, Any], step: PipelineStep | None) -> None:
    """Print standardized configuration details."""
    print(f"Client: {config['client']}")
    print(f"Analysis context: {config['analysis_context']}")
    print(f"Procurement/Serving: {config['procurement_serving']}")
    print(f"Sub-client: {config['sub_client_name']}")
    print(f"Base filepath: {config['base_filepath']}")
    if step == "pilot":
        print(f"Baseline input file: {Path(config['baseline_input_file']).name}")
        print(f"Pilot input file: {Path(config['pilot_input_file']).name}")
    elif step in {"categorize", "clean_units", "produce_food_report"}:
        print(f"Input file: {Path(config['input_file']).name}")
    if step == "produce_food_report":
        print(f"PDF output file: {Path(config['pdf_output_file']).name}")
        print(f"Excel output file: {Path(config['excel_output_file']).name}")
    elif step and step != "pilot":
        print(f"Output file: {Path(config['output_file']).name}")


def detect_client_structure(
    has_sub_client: bool,
    step: PipelineStep | None = None,
    *,
    analysis_context: AnalysisContext | None = None,
    client_override: str | None = None,
    procurement_serving_override: Literal[
        "purchasing-procurement data",
        "sales-serving data",
    ]
    | None = None,
    base_filepath_override: str | Path | None = None,
) -> dict[str, Any]:
    """
    Detect client context from cwd and generate step-specific file paths.

    Step options:
    - prepare_tabular
    - prepare_pdf
    - categorize
    - clean_units
    - produce_food_report
    - pilot
    """
    assert isinstance(has_sub_client, bool), "has_sub_client must be True or False"
    _validate_step(step)

    cwd = Path.cwd().resolve()

    # Infer structural fields from cwd where possible
    if has_sub_client:
        inferred_sub_client = cwd.name
        inferred_procurement_serving = cwd.parent.name
        inferred_baseline_pilot = cwd.parent.parent.name
        inferred_client = cwd.parent.parent.parent.name
    else:
        inferred_sub_client = None
        inferred_procurement_serving = cwd.name
        inferred_baseline_pilot = cwd.parent.name
        inferred_client = cwd.parent.parent.name

    resolved_context = _resolve_analysis_context(
        analysis_context=analysis_context,
        path_parts=cwd.parts,
    )

    client = client_override or inferred_client
    procurement_serving = procurement_serving_override or inferred_procurement_serving
    if procurement_serving not in VALID_PROCUREMENT_SERVING:
        procurement_serving = None

    base_path = (
        Path(base_filepath_override).resolve() if base_filepath_override is not None else cwd
    )

    if resolved_context == "web_app":
        missing_fields: list[str] = []
        if not client:
            missing_fields.append("client_override")
        if not procurement_serving:
            missing_fields.append("procurement_serving_override")
        if missing_fields:
            raise ValueError(
                "web_app context requires required fields when they cannot be inferred: "
                + ", ".join(missing_fields)
            )
    else:
        inferred_folder_context = inferred_baseline_pilot.strip().lower()
        if inferred_folder_context not in {"baseline", "pilot"}:
            raise ValueError(
                f"Invalid directory name for baseline/pilot context: {inferred_baseline_pilot!r}."
            )

        if not procurement_serving:
            raise ValueError(
                "Invalid directory name. Expected 'purchasing-procurement data' or "
                "'sales-serving data'."
            )

    if not client:
        raise ValueError("Could not infer client name. Pass client_override explicitly.")

    parts = [client, resolved_context]
    if inferred_sub_client:
        parts.append(inferred_sub_client)
    parts.append(procurement_serving)

    result: dict[str, Any] = {
        "client": client,
        "analysis_context": resolved_context,
        "baseline_pilot": resolved_context,
        "procurement_serving": procurement_serving,
        "sub_client_name": inferred_sub_client,
        "base_filepath": str(base_path),
        "data_location": base_path / "raw_data",
        "parts": parts,
    }

    existing_metadata = _load_existing_metadata(base_path)
    _apply_step_file_paths(result, step, metadata=existing_metadata)
    _validate_required_input_files(result, step)
    _print_configuration(result, step)
    return result


def save_client_metadata(config: dict[str, Any], env_path: str | Path, pdf_extracted: bool) -> None:
    """
    Save client metadata and ENV_PATH to client_metadata.json in the data type folder.
    """
    config_serializable = config.copy()
    if "data_location" in config_serializable:
        config_serializable["data_location"] = str(config_serializable["data_location"])

    analysis_context = config_serializable.get("analysis_context")
    if analysis_context is None:
        raise ValueError("config must include 'analysis_context'.")

    config_serializable["analysis_context"] = analysis_context
    config_serializable["env_path"] = str(env_path)
    config_serializable["has_sub_client"] = config["sub_client_name"] is not None
    config_serializable["pdf_extracted"] = pdf_extracted

    metadata_path = Path(config["base_filepath"]) / "client_metadata.json"
    with open(metadata_path, "w") as f:
        json.dump(config_serializable, indent=2, fp=f)

    print(f"✓ Saved client metadata to {metadata_path.name}")


def load_client_metadata(
    step: PipelineStep | None = None,
    *,
    analysis_context: AnalysisContext | None = None,
) -> tuple[dict[str, Any], str, bool]:
    """
    Load client metadata from client_metadata.json in the current data folder.
    """
    _validate_step(step)

    cwd = Path.cwd()
    metadata_path = cwd / "client_metadata.json"
    if not metadata_path.exists():
        raise FileNotFoundError(
            f"client_metadata.json not found in {cwd}\n"
            "Please run prepare step first to generate metadata."
        )

    with open(metadata_path) as f:
        metadata = json.load(f)

    env_path = metadata.pop("env_path")
    metadata.pop("has_sub_client", None)
    pdf_extracted = metadata.pop("pdf_extracted")

    if "data_location" in metadata:
        metadata["data_location"] = Path(metadata["data_location"])

    resolved_context = _resolve_analysis_context(
        analysis_context=analysis_context,
        path_parts=cwd.parts,
    )
    metadata["analysis_context"] = resolved_context

    _apply_step_file_paths(metadata, step, metadata=metadata)
    _validate_required_input_files(metadata, step)

    print(f"✓ Loaded client metadata from {metadata_path.name}")
    _print_configuration(metadata, step)
    return metadata, env_path, pdf_extracted


def setup_cli_environment(env_path: str | Path | None = None) -> dict[str, Any]:
    """
    Load .env configuration for CLI scripts and initialize API clients.
    """
    from dotenv import find_dotenv, load_dotenv

    if env_path is None:
        env_path = find_dotenv(usecwd=True)
    load_dotenv(dotenv_path=env_path)

    clients = setup_api_clients(openai=True, gemini=True)
    return {
        "openai_client": clients["openai_client"],
        "gemini_client": clients["gemini_client"],
    }


def update_metadata(updates: dict) -> None:
    """
    Update specific fields in client_metadata.json.

    Reads the existing metadata file, applies the given key-value updates,
    and writes it back. Use this to record outputs from any pipeline step
    so subsequent steps can auto-detect the correct input file.

    Args:
        updates: A dict of keys and values to set or overwrite in the metadata.

    Example:
        >>> update_metadata({"report_input_file": output_file})
    """
    metadata_path = Path.cwd() / "client_metadata.json"
    if not metadata_path.exists():
        logger.warning("client_metadata.json not found in %s. Metadata not updated.", Path.cwd())
        return
    with open(metadata_path) as f:
        metadata = json.load(f)
    metadata.update(updates)
    with open(metadata_path, "w") as f:
        json.dump(_to_json_serializable(metadata), f, indent=2)
    logger.info("Updated client_metadata.json: %s", list(updates.keys()))


def update_metadata_with_categorization_stats(summary: dict[str, Any]) -> None:
    """
    Update client_metadata.json with categorization statistics.
    """
    output_file = summary.get("output_file", "")
    human_review_file = summary.get("human_review_file", "")
    update_metadata(
        {
            "categorization_stats": {
                "n_products_before": summary["n_products_before"],
                "n_products_after": summary["n_products_after"],
                "pct_remaining": summary["pct_remaining"],
                "n_rows_before": summary["n_rows_before"],
                "n_rows_after": summary["n_rows_after"],
                "row_elimination_details": summary.get("row_elimination_details", {}),
                "output_file": output_file,
                "human_review_file": human_review_file,
                "timestamp": datetime.now().isoformat(),
            },
            "categorized_output_file": output_file,
            "categorization_human_review_file": human_review_file,
            "report_input_file": output_file,
        }
    )
