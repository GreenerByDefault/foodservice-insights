import json
from pathlib import Path

import numpy as np
import pytest
from gbd_foodservice_insights_lab import PACKAGE_DIR
from gbd_foodservice_insights_lab.notebook_runscript_setup import (
    ANALYSIS_CONTEXT_ENV_VAR,
    detect_client_structure,
    get_customer_template_dir,
    load_client_metadata,
    save_client_metadata,
    update_metadata_with_categorization_stats,
)


def _create_baseline_procurement_dir(tmp_path: Path) -> Path:
    data_dir = tmp_path / "client" / "baseline" / "purchasing-procurement data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "raw_data").mkdir(exist_ok=True)
    return data_dir


def _write_client_metadata(data_dir: Path, **overrides: object) -> dict:
    metadata: dict = {
        "client": "client",
        "analysis_context": "baseline",
        "baseline_pilot": "baseline",
        "procurement_serving": "purchasing-procurement data",
        "sub_client_name": None,
        "base_filepath": str(data_dir),
        "data_location": str(data_dir / "raw_data"),
        "parts": ["client", "baseline", "purchasing-procurement data"],
        "env_path": str(data_dir / "test.env"),  # nosec B108
        "has_sub_client": False,
        "pdf_extracted": False,
    }
    metadata.update(overrides)
    with open(data_dir / "client_metadata.json", "w") as f:
        json.dump(metadata, f, indent=2)
    return metadata


def test_runscripts_dir_is_discovered_from_package():
    """Checks scripts can find shared templates without a user-specific laptop path."""
    template_dir = get_customer_template_dir()

    assert template_dir == PACKAGE_DIR.parent / "runscripts"
    assert (template_dir / "2. Produce Food Report.py").exists()


def test_save_client_metadata_serializes_path_env_value(tmp_path):
    """A Path-valued .env location should be saved as JSON text for the template runscript."""
    data_dir = _create_baseline_procurement_dir(tmp_path)
    config = {
        "analysis_context": "baseline",
        "sub_client_name": None,
        "base_filepath": str(data_dir),
        "data_location": data_dir / "raw_data",
    }
    env_path = tmp_path / ".env"

    save_client_metadata(config, env_path=env_path, pdf_extracted=False)

    metadata = json.loads((data_dir / "client_metadata.json").read_text())
    assert metadata["env_path"] == str(env_path)
    assert metadata["data_location"] == str(data_dir / "raw_data")


def test_context_override_wins_env_and_path(tmp_path, monkeypatch):
    """Confirms explicit args take precedence over env/path inference for deterministic notebook
    runs. This matters because step/context routing decides which files each notebook step reads
    and writes."""
    data_dir = _create_baseline_procurement_dir(tmp_path)
    monkeypatch.chdir(data_dir)
    monkeypatch.setenv(ANALYSIS_CONTEXT_ENV_VAR, "baseline")

    config = detect_client_structure(
        has_sub_client=False,
        analysis_context="pilot",
    )

    assert config["analysis_context"] == "pilot"
    assert config["baseline_pilot"] == "pilot"


def test_context_env_wins_path(tmp_path, monkeypatch):
    """Confirms env-based context override works, enabling scripted runs outside canonical
    folders. This matters because step/context routing decides which files each notebook step
    reads and writes."""
    data_dir = _create_baseline_procurement_dir(tmp_path)
    monkeypatch.chdir(data_dir)
    monkeypatch.setenv(ANALYSIS_CONTEXT_ENV_VAR, "web_app")

    config = detect_client_structure(has_sub_client=False)

    assert config["analysis_context"] == "web_app"
    assert config["baseline_pilot"] == "web_app"


def test_context_inferred_from_path_when_no_override_or_env(tmp_path, monkeypatch):
    data_dir = _create_baseline_procurement_dir(tmp_path)
    monkeypatch.chdir(data_dir)
    monkeypatch.delenv(ANALYSIS_CONTEXT_ENV_VAR, raising=False)

    config = detect_client_structure(has_sub_client=False)

    assert config["analysis_context"] == "baseline"
    assert config["baseline_pilot"] == "baseline"


def test_context_unresolved_raises_error(tmp_path, monkeypatch):
    """Requires loud failure when context cannot be inferred, preventing wrong-pipeline execution.
    This matters because step/context routing decides which files each notebook step reads and
    writes."""
    unresolved_dir = tmp_path / "unknown" / "data"
    unresolved_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(unresolved_dir)
    monkeypatch.delenv(ANALYSIS_CONTEXT_ENV_VAR, raising=False)

    with pytest.raises(ValueError, match="Could not infer analysis context"):
        detect_client_structure(has_sub_client=False)


def test_step_mapping_for_new_pipeline(tmp_path, monkeypatch):
    """Validates file handoff between new pipeline steps so each notebook/script reads the right
    artifact."""
    data_dir = _create_baseline_procurement_dir(tmp_path)
    monkeypatch.chdir(data_dir)
    monkeypatch.delenv(ANALYSIS_CONTEXT_ENV_VAR, raising=False)

    prepare_tabular = detect_client_structure(
        has_sub_client=False,
        step="prepare_tabular",
        analysis_context="baseline",
    )
    prepare_pdf = detect_client_structure(
        has_sub_client=False,
        step="prepare_pdf",
        analysis_context="baseline",
    )
    assert prepare_tabular["output_file"] == prepare_pdf["output_file"]

    Path(prepare_tabular["output_file"]).touch()
    categorize = detect_client_structure(
        has_sub_client=False,
        step="categorize",
        analysis_context="baseline",
    )
    assert categorize["input_file"] == prepare_tabular["output_file"]
    assert categorize["output_file"].endswith("_categorized.csv")

    Path(categorize["output_file"]).touch()
    clean_units = detect_client_structure(
        has_sub_client=False,
        step="clean_units",
        analysis_context="baseline",
    )
    assert clean_units["input_file"] == categorize["output_file"]
    assert clean_units["output_file"].endswith("_units_cleaned.csv")

    Path(clean_units["output_file"]).touch()
    report = detect_client_structure(
        has_sub_client=False,
        step="produce_food_report",
        analysis_context="baseline",
    )
    assert report["input_file"] == clean_units["output_file"]
    expected_output_dir = (
        Path(report["input_file"]).parent
        / "outputs"
        / Path(report["input_file"]).stem.replace("categorized_", "")
    )
    assert Path(report["excel_output_file"]).parent == expected_output_dir
    assert Path(report["pdf_output_file"]).parent == expected_output_dir
    assert report["excel_output_file"].endswith(".xlsx")
    assert report["pdf_output_file"].endswith(".pdf")
    assert report["output_file"] == report["excel_output_file"]


def test_invalid_step_raises_error(tmp_path, monkeypatch):
    """Ensures unsupported pipeline steps error immediately instead of producing ambiguous
    outputs."""
    data_dir = _create_baseline_procurement_dir(tmp_path)
    monkeypatch.chdir(data_dir)
    monkeypatch.delenv(ANALYSIS_CONTEXT_ENV_VAR, raising=False)

    with pytest.raises(ValueError, match="Invalid step"):
        detect_client_structure(
            has_sub_client=False,
            step="extract",  # ty: ignore[invalid-argument-type]  # Deliberately invalid pipeline step verifies configuration errors fail immediately.
        )


def test_load_client_metadata_clean_units_prefers_categorized_output_file(tmp_path, monkeypatch):
    """Checks metadata precedence so clean-units reads the canonical categorized output when
    available."""
    data_dir = _create_baseline_procurement_dir(tmp_path)
    preferred_categorized = data_dir / "preferred_categorized.csv"
    fallback_categorized = data_dir / "fallback_categorized.csv"
    preferred_categorized.touch()
    fallback_categorized.touch()

    _write_client_metadata(
        data_dir,
        categorized_output_file=str(preferred_categorized),
        categorization_stats={"output_file": str(fallback_categorized)},
    )
    monkeypatch.chdir(data_dir)
    monkeypatch.delenv(ANALYSIS_CONTEXT_ENV_VAR, raising=False)

    config, _, _ = load_client_metadata(step="clean_units", analysis_context="baseline")

    assert config["input_file"] == str(preferred_categorized)
    assert config["output_file"].endswith("_units_cleaned.csv")


def test_load_client_metadata_report_prefers_report_input_file(tmp_path, monkeypatch):
    """Checks report-step metadata override so analysts can pin an explicit report input
    artifact."""
    data_dir = _create_baseline_procurement_dir(tmp_path)
    report_input = data_dir / "custom_report_input.csv"
    report_input.touch()

    _write_client_metadata(data_dir, report_input_file=str(report_input))
    monkeypatch.chdir(data_dir)
    monkeypatch.delenv(ANALYSIS_CONTEXT_ENV_VAR, raising=False)

    config, _, _ = load_client_metadata(
        step="produce_food_report",
        analysis_context="baseline",
    )

    assert config["input_file"] == str(report_input)
    expected_output_dir = (
        report_input.parent / "outputs" / report_input.stem.replace("categorized_", "")
    )
    assert Path(config["excel_output_file"]).parent == expected_output_dir
    assert Path(config["pdf_output_file"]).parent == expected_output_dir
    assert config["excel_output_file"].endswith(".xlsx")
    assert config["pdf_output_file"].endswith(".pdf")
    assert config["output_file"] == config["excel_output_file"]


def test_update_metadata_with_categorization_stats_sets_expected_keys(tmp_path, monkeypatch):
    """Verifies metadata contract keys are populated for later steps and UI/report consumers. This
    matters because step/context routing decides which files each notebook step reads and
    writes."""
    data_dir = _create_baseline_procurement_dir(tmp_path)
    _write_client_metadata(data_dir)
    monkeypatch.chdir(data_dir)

    summary = {
        "n_products_before": 10,
        "n_products_after": 8,
        "pct_remaining": 0.8,
        "n_rows_before": 100,
        "n_rows_after": 90,
        "row_elimination_details": {"reason": 10},
        "output_file": str(data_dir / "categorized_output.csv"),
        "human_review_file": str(data_dir / "categorized_output_for_human_review.csv"),
    }
    update_metadata_with_categorization_stats(summary)

    with open(data_dir / "client_metadata.json") as f:
        updated = json.load(f)

    assert updated["categorized_output_file"] == summary["output_file"]
    assert updated["report_input_file"] == summary["output_file"]
    assert updated["categorization_human_review_file"] == summary["human_review_file"]
    assert updated["categorization_stats"]["output_file"] == summary["output_file"]
    assert updated["categorization_stats"]["human_review_file"] == summary["human_review_file"]


def test_update_metadata_with_categorization_stats_serializes_numpy_scalars(tmp_path, monkeypatch):
    """Ensures NumPy scalar stats become JSON-safe primitives, avoiding broken metadata files."""
    data_dir = _create_baseline_procurement_dir(tmp_path)
    _write_client_metadata(data_dir)
    monkeypatch.chdir(data_dir)

    summary = {
        "n_products_before": np.int64(10),
        "n_products_after": np.int64(8),
        "pct_remaining": np.float64(0.8),
        "n_rows_before": np.int64(100),
        "n_rows_after": np.int64(90),
        "row_elimination_details": {
            "rows_eliminated_uncategorized": np.int64(10),
            "rows_eliminated_uncategorized_pct": np.float64(0.1),
        },
        "output_file": str(data_dir / "categorized_output.csv"),
        "human_review_file": str(data_dir / "categorized_output_for_human_review.csv"),
    }

    update_metadata_with_categorization_stats(summary)

    with open(data_dir / "client_metadata.json") as f:
        updated = json.load(f)

    assert updated["categorization_stats"]["n_products_before"] == 10
    assert updated["categorization_stats"]["n_products_after"] == 8
    assert updated["categorization_stats"]["pct_remaining"] == 0.8
    assert updated["categorization_stats"]["n_rows_before"] == 100
    assert updated["categorization_stats"]["n_rows_after"] == 90
    assert updated["categorization_human_review_file"] == summary["human_review_file"]
    assert updated["categorization_stats"]["human_review_file"] == summary["human_review_file"]
    assert (
        updated["categorization_stats"]["row_elimination_details"]["rows_eliminated_uncategorized"]
        == 10
    )
