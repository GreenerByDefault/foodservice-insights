"""PDF extraction and review helpers for heterogeneous catering PDFs.

Why this module is shaped this way:
    PDF extraction is one of the messiest parts of the repo because the input data is
    highly heterogeneous. A future reviewer should not have to reverse-engineer why
    there are multiple parser modes, audit manifests, or repair passes, so this file
    deliberately carries more architecture comments than the repo norm.

Pipeline stages:
    1. Preflight: sample a few real pages so the analyst can see raw text, parsed rows,
       nulls, and audit scores before committing to a full run.
    2. Extract: route each page to an LLMWhisperer profile that matches the page shape.
    3. Parse: convert extracted text into either markdown tables or structured JSON rows.
    4. Audit: score each candidate on completeness, parse quality, duplication risk, OCR
       confidence, and row-level source evidence.
    5. Repair: when the first attempt is weak, retry in a fixed order so the pipeline is
       deterministic and easy to debug.
    6. Export: keep the CSV contract stable, but persist sidecar metadata so humans can
       later understand why a page was accepted, retried, or flagged.

Public entrypoints:
    - run_pdf_preflight_sample()
    - run_pdf_extraction_pipeline()
    - run_pdf_extraction_pipeline_multiple_files()
    - summarize_pdf_validation_data()
"""

import hashlib
import io
import json
import logging
import os
import random
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import pandas as pd
from gbd_foodservice_insights.gemini import get_gemini_model
from gbd_foodservice_insights.plotting_utils import GBD_colors
from matplotlib.ticker import MaxNLocator
from PyPDF2 import PdfReader
from thefuzz import fuzz

from gbd_foodservice_insights_lab.extraction.llm import (
    LLMWhispererClientException,
    call_gemini_pdf_upload_with_metadata,
)
from gbd_foodservice_insights_lab.extraction.llm import (
    call_openai_prompt_with_metadata as shared_call_openai_prompt_with_metadata,
)
from gbd_foodservice_insights_lab.extraction.llm import (
    extract_pdf_text_whisper_with_metadata as shared_extract_pdf_text_whisper_with_metadata,
)
from gbd_foodservice_insights_lab.llm_prompts import load_prompt
from gbd_foodservice_insights_lab.notebook_utils import get_head_and_tail

# ----------------------------------------------------------------------
# Numerical Constants
# ----------------------------------------------------------------------
DEFAULT_MISSPELLING_SIMILARITY_THRESHOLD = 85
DEFAULT_API_MAX_RETRIES = 3
DEFAULT_MAX_CONCURRENT_FILES = 2
DEFAULT_TUNING_SAMPLE_CAP = 10
DEFAULT_TUNING_RANDOM_SEED = 42
DEFAULT_AUDIT_THRESHOLD = 0.90
DEFAULT_VISUAL_AUDIT_THRESHOLD = 0.75
DEFAULT_MAX_REPAIR_ATTEMPTS = 2
GEMINI_VISUAL_FALLBACK_MODEL = get_gemini_model("extract_pdf.gemini_visual_fallback")
NO_TABLE_STATUS = "no_table_detected"
AUDIT_FAILED_STATUS = "audit_failed"
COMPLETED_PAGE_STATUSES = {"processed", "skipped_existing", NO_TABLE_STATUS}
PARSER_MODES = {"auto", "markdown", "json_rows"}
DEFAULT_OPENAI_PDF_MODEL = "gpt-4o"

# We keep the profile catalogue explicit instead of scattering string literals
# throughout the file. That makes routing decisions and repair manifests much
# easier to review later.
WHISPER_PROFILE_OPTIONS: dict[str, dict[str, Any]] = {
    "native_text": {
        "mode": "native_text",
        "mark_horizontal_lines": False,
        "mark_vertical_lines": False,
    },
    "table": {
        "mode": "table",
        "mark_horizontal_lines": True,
        "mark_vertical_lines": True,
    },
    "high_quality": {
        "mode": "high_quality",
        "mark_horizontal_lines": True,
        "mark_vertical_lines": True,
    },
}

WHISPER_TUNING_CANDIDATES: dict[str, dict[str, Any]] = {
    "native_text": WHISPER_PROFILE_OPTIONS["native_text"],
    "table": WHISPER_PROFILE_OPTIONS["table"],
    # High-quality is intentionally only used as the scan route or repair route.
    # We do not make it the default digital-PDF profile unless a caller opts into
    # it explicitly, because it is slower and less predictable for machine text.
    "high_quality_scan": {
        "mode": "high_quality",
        "mark_horizontal_lines": True,
        "mark_vertical_lines": True,
    },
}


# ----------------------------------------------------------------------
# Column Handling Utilities
# ----------------------------------------------------------------------
def standardize_columns(columns: list[str]) -> list[str]:
    """Standardize column names to lowercase and strip whitespace for case-insensitive handling."""
    return [col.strip().lower() for col in columns]


def _debug_folder(data_location: Path) -> Path:
    """Store debug files beside the extracted outputs for the current dataset."""
    return data_location / "debug"


def _write_debug_artifact(
    data_location: Path,
    filename: str,
    content: str,
    save_debug_artifacts: bool,
) -> None:
    """Persist a debug artifact when the caller opts in."""
    if not save_debug_artifacts:
        return
    debug_dir = _debug_folder(data_location)
    debug_dir.mkdir(exist_ok=True)
    (debug_dir / filename).write_text(content, encoding="utf-8")


def _page_output_path(extracted_pages_dir: Path, file_name: str, page: int) -> Path:
    """Return the standard checkpoint path for a single extracted page."""
    return extracted_pages_dir / f"{Path(file_name).stem}_page_{page}_extracted.csv"


def _combined_output_path(extracted_files_dir: Path, file_name: str) -> Path:
    """Return the standard combined output path for a fully processed PDF."""
    return extracted_files_dir / f"{Path(file_name).stem}_combined_extracted.csv"


def _page_metadata_dir(data_location: Path) -> Path:
    """Store page-level sidecars separately so CSV outputs stay backward-compatible."""
    return data_location / "page_metadata"


def _audit_manifest_dir(data_location: Path) -> Path:
    """Persist candidate scoring in its own folder for easier debugging."""
    return data_location / "audit_manifests"


def _qa_flags_dir(data_location: Path) -> Path:
    """QA artifacts are additive and human-facing, so keep them separate from CSVs."""
    return data_location / "qa_flags"


def _tuning_cache_dir(data_location: Path) -> Path:
    """Store auto-tuning choices separately so interrupted runs can resume quickly."""
    return data_location / "tuning_cache"


def _page_metadata_path(data_location: Path, file_name: str, page: int) -> Path:
    """Return the JSON sidecar path for a single page's extraction metadata.

    Args:
        data_location: Root data directory for the dataset.
        file_name: PDF file name the page belongs to.
        page: 1-indexed page number.

    Returns:
        Path under ``page_metadata/`` for the page's metadata JSON.
    """
    return _page_metadata_dir(data_location) / f"{Path(file_name).stem}_page_{page}_metadata.json"


def _page_audit_manifest_path(data_location: Path, file_name: str, page: int) -> Path:
    """Return the JSON path for a single page's audit manifest.

    Args:
        data_location: Root data directory for the dataset.
        file_name: PDF file name the page belongs to.
        page: 1-indexed page number.

    Returns:
        Path under ``audit_manifests/`` for the page's audit JSON.
    """
    return _audit_manifest_dir(data_location) / f"{Path(file_name).stem}_page_{page}_audit.json"


def _qa_flags_path(data_location: Path, file_name: str) -> Path:
    """Return the JSON path for a file's QA-flag artifact.

    Args:
        data_location: Root data directory for the dataset.
        file_name: PDF file name the flags apply to.

    Returns:
        Path under ``qa_flags/`` for the file's QA flags JSON.
    """
    return _qa_flags_dir(data_location) / f"{Path(file_name).stem}_qa_flags.json"


def _read_json_artifact(path: Path) -> dict[str, Any]:
    """Best-effort JSON reader for metadata sidecars."""
    if not path.exists():
        return {}
    try:
        with open(path, encoding="utf-8") as handle:
            loaded = json.load(handle)
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
        logging.warning("Could not read sidecar %s: %s", path, exc)
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _write_json_artifact(path: Path, payload: dict[str, Any]) -> None:
    """All sidecars are JSON so analysts can inspect them without custom tooling."""
    path.parent.mkdir(exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=True)


def _prompt_hash(prompt: str) -> str:
    """Hash prompts so checkpoint reuse respects prompt edits without storing the whole prompt."""
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


def _settings_signature(settings: dict[str, Any]) -> str:
    """Create a stable signature for checkpoint reuse decisions."""
    serialized = json.dumps(settings, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _summarize_text(text: str, limit: int = 600) -> str:
    """Keep sidecars readable by storing previews instead of full prompt responses."""
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit].rstrip()}..."


def _normalize_parser_mode(parser_mode: str, CBORD: bool) -> str:
    """CBORD defaults to structured parsing; non-CBORD keeps markdown by default."""
    if parser_mode not in PARSER_MODES:
        raise ValueError(f"parser_mode must be one of {sorted(PARSER_MODES)}")
    if parser_mode == "auto":
        return "json_rows" if CBORD else "markdown"
    return parser_mode


def _normalize_extraction_profile(extraction_profile: str) -> str:
    """Validate and return a known extraction-profile name.

    Args:
        extraction_profile: Caller-supplied profile name.

    Returns:
        The same profile string if it is valid.

    Raises:
        ValueError: If the profile is not one of the supported values.
    """
    valid_profiles = {"auto", *WHISPER_PROFILE_OPTIONS.keys()}
    if extraction_profile not in valid_profiles:
        raise ValueError(f"extraction_profile must be one of {sorted(valid_profiles)}")
    return extraction_profile


def _build_run_settings_signature(
    *,
    desired_columns: list[str],
    numeric_columns: list[str],
    parse_extracted_pdf_prompt: str,
    parser_mode: str,
    extraction_profile: str,
    CBORD: bool,
    audit_threshold: float,
    visual_audit_threshold: float,
    enable_gemini_fallback: bool,
    max_repair_attempts: int,
) -> str:
    """Only checkpoint-compatible settings belong in this signature."""
    return _settings_signature(
        {
            "desired_columns": desired_columns,
            "numeric_columns": numeric_columns,
            "prompt_hash": _prompt_hash(parse_extracted_pdf_prompt),
            "parser_mode": parser_mode,
            "extraction_profile": extraction_profile,
            "CBORD": CBORD,
            "audit_threshold": audit_threshold,
            "visual_audit_threshold": visual_audit_threshold,
            "enable_gemini_fallback": enable_gemini_fallback,
            "max_repair_attempts": max_repair_attempts,
        }
    )


def _build_tuning_cache_signature(
    pdf_files: list[str],
    data_location: Path,
    *,
    sample_cap: int,
    random_seed: int,
) -> str:
    """Reuse tuning only when the source PDFs and tuning inputs still match."""
    pdf_fingerprints: list[dict[str, Any]] = []
    for file_name in pdf_files:
        pdf_path = data_location / file_name
        if not pdf_path.exists():
            pdf_fingerprints.append({"file_name": file_name, "exists": False})
            continue
        pdf_stat = pdf_path.stat()
        pdf_fingerprints.append(
            {
                "file_name": file_name,
                "exists": True,
                "size": pdf_stat.st_size,
                "mtime_ns": pdf_stat.st_mtime_ns,
            }
        )
    return _settings_signature(
        {
            "pdf_files": pdf_fingerprints,
            "sample_cap": sample_cap,
            "random_seed": random_seed,
            "tuning_candidates": WHISPER_TUNING_CANDIDATES,
        }
    )


def _tuning_cache_path(
    pdf_files: list[str],
    data_location: Path,
    *,
    sample_cap: int,
    random_seed: int,
) -> Path:
    cache_signature = _build_tuning_cache_signature(
        pdf_files,
        data_location,
        sample_cap=sample_cap,
        random_seed=random_seed,
    )
    return _tuning_cache_dir(data_location) / f"{cache_signature}.json"


def _load_cached_tuning_result(
    pdf_files: list[str],
    data_location: Path,
    *,
    sample_cap: int,
    random_seed: int,
) -> dict[str, Any] | None:
    """Load a previously benchmarked profile choice when the tuning inputs still match."""
    cache_path = _tuning_cache_path(
        pdf_files,
        data_location,
        sample_cap=sample_cap,
        random_seed=random_seed,
    )
    cached_result = _read_json_artifact(cache_path)
    preferred_profile = cached_result.get("preferred_digital_profile")
    if preferred_profile not in {"native_text", "table"}:
        return None
    if not isinstance(cached_result.get("scores"), dict):
        return None
    if not isinstance(cached_result.get("sample_pages"), list):
        return None
    return {
        "preferred_digital_profile": preferred_profile,
        "scores": cached_result.get("scores", {}),
        "sample_pages": cached_result.get("sample_pages", []),
    }


def _persist_tuning_result(
    pdf_files: list[str],
    data_location: Path,
    tuning_result: dict[str, Any],
    *,
    sample_cap: int,
    random_seed: int,
) -> None:
    """Persist auto-tuning so reruns after a crash can skip the benchmark step."""
    cache_path = _tuning_cache_path(
        pdf_files,
        data_location,
        sample_cap=sample_cap,
        random_seed=random_seed,
    )
    _write_json_artifact(
        cache_path,
        {
            "created_at_epoch": time.time(),
            "pdf_files": pdf_files,
            "sample_cap": sample_cap,
            "random_seed": random_seed,
            "preferred_digital_profile": tuning_result.get("preferred_digital_profile"),
            "scores": tuning_result.get("scores", {}),
            "sample_pages": tuning_result.get("sample_pages", []),
        },
    )


def _resolve_auto_tuning_result(
    pdf_files: list[str],
    data_location: Path,
    *,
    whisper_client: Any,
    sample_cap: int = DEFAULT_TUNING_SAMPLE_CAP,
    random_seed: int = DEFAULT_TUNING_RANDOM_SEED,
    announce: bool = True,
) -> dict[str, Any]:
    """Reuse cached tuning when possible and benchmark only when necessary."""
    cached_result = _load_cached_tuning_result(
        pdf_files,
        data_location,
        sample_cap=sample_cap,
        random_seed=random_seed,
    )
    if cached_result is not None:
        if announce:
            print(
                (
                    "Using cached PDF auto-tuning profile "
                    f"'{cached_result['preferred_digital_profile']}'."
                ),
                flush=True,
            )
        return cached_result

    sample_pages = _sample_tuning_pages(
        pdf_files,
        data_location,
        sample_cap=sample_cap,
        random_seed=random_seed,
    )
    if announce:
        print(
            f"Benchmarking PDF auto-tuning on {len(sample_pages)} sampled page(s)...",
            flush=True,
        )
    tuning_result = _benchmark_digital_profiles(
        sample_pages,
        data_location=data_location,
        whisper_client=whisper_client,
    )
    _persist_tuning_result(
        pdf_files,
        data_location,
        tuning_result,
        sample_cap=sample_cap,
        random_seed=random_seed,
    )
    if announce:
        print(
            (
                "Saved PDF auto-tuning profile "
                f"'{tuning_result.get('preferred_digital_profile')}' for reuse."
            ),
            flush=True,
        )
    return tuning_result


def _count_pages(pdf_path: Path) -> int:
    """Return the number of pages in a PDF file."""
    return len(PdfReader(pdf_path).pages)


def _validate_existing_page_output(
    output_file_path: Path,
    expected_columns: list[str],
    metadata_path: Path | None = None,
    expected_settings_signature: str | None = None,
) -> bool:
    """Treat only schema-compatible outputs with matching settings as reusable checkpoints."""
    metadata = _read_json_artifact(metadata_path) if metadata_path else {}
    if metadata and expected_settings_signature is not None:
        if metadata.get("settings_signature") != expected_settings_signature:
            return False
        if metadata.get("status") == NO_TABLE_STATUS:
            return True

    if not output_file_path.exists():
        return False
    try:
        existing_df = pd.read_csv(output_file_path)
    except (pd.errors.ParserError, pd.errors.EmptyDataError, ValueError, OSError) as exc:
        logging.warning("Could not read existing page output %s: %s", output_file_path, exc)
        return False
    if existing_df.empty:
        return False
    standardized_columns = standardize_columns(existing_df.columns.tolist())
    return set(expected_columns).issubset(set(standardized_columns))


def _summarize_page_statuses(file_name: str, page_statuses: list[dict[str, Any]]) -> dict[str, Any]:
    """Convert page-level results into a compact file-level summary."""
    status_counts: dict[str, int] = {
        "processed": 0,
        "skipped_existing": 0,
        NO_TABLE_STATUS: 0,
        "no_text": 0,
        "api_failed": 0,
        "llm_empty": 0,
        "parse_failed": 0,
        AUDIT_FAILED_STATUS: 0,
    }
    failed_pages: list[str] = []
    retry_events = 0
    retryable_api_failures = 0
    for status in page_statuses:
        status_counts[status["status"]] = status_counts.get(status["status"], 0) + 1
        retry_events += status.get("retry_count", 0)
        if status["status"] == "api_failed" and status.get("retryable", False):
            retryable_api_failures += 1
        if status["status"] not in COMPLETED_PAGE_STATUSES:
            failed_pages.append(f"page {status['page']}: {status['error']}")
    summary: dict[str, Any] = {
        "file_name": Path(file_name).name,
        **status_counts,
        "retry_events": retry_events,
        "retryable_api_failures": retryable_api_failures,
        "failed_pages": failed_pages,
    }
    return summary


def _print_file_summary(file_summary: dict[str, Any]) -> None:
    """Emit a concise summary that analysts can scan quickly."""
    print(
        f"File summary for {file_summary['file_name']}: "
        f"processed={file_summary['processed']}, "
        f"skipped_existing={file_summary['skipped_existing']}, "
        f"no_table_detected={file_summary[NO_TABLE_STATUS]}, "
        f"no_text={file_summary['no_text']}, "
        f"api_failed={file_summary['api_failed']}, "
        f"llm_empty={file_summary['llm_empty']}, "
        f"parse_failed={file_summary['parse_failed']}, "
        f"audit_failed={file_summary[AUDIT_FAILED_STATUS]}, "
        f"retry_events={file_summary['retry_events']}"
    )


def _print_batch_error_summary(summary_df: pd.DataFrame, failed_file_count: int) -> None:
    """Print a compact run-level summary so notebooks do not need to inspect the raw DataFrame."""
    summary_rows = [
        {"metric": "files_processed", "count": len(summary_df)},
        {"metric": "files_failed", "count": int(failed_file_count)},
        {
            "metric": "pages_processed",
            "count": int(summary_df["processed"].sum()) if "processed" in summary_df.columns else 0,
        },
        {
            "metric": "pages_skipped_existing",
            "count": int(summary_df["skipped_existing"].sum())
            if "skipped_existing" in summary_df.columns
            else 0,
        },
        {
            "metric": "pages_no_table_detected",
            "count": int(summary_df[NO_TABLE_STATUS].sum())
            if NO_TABLE_STATUS in summary_df.columns
            else 0,
        },
        {
            "metric": "pages_no_text",
            "count": int(summary_df["no_text"].sum()) if "no_text" in summary_df.columns else 0,
        },
        {
            "metric": "pages_api_failed",
            "count": int(summary_df["api_failed"].sum())
            if "api_failed" in summary_df.columns
            else 0,
        },
        {
            "metric": "pages_llm_empty",
            "count": int(summary_df["llm_empty"].sum()) if "llm_empty" in summary_df.columns else 0,
        },
        {
            "metric": "pages_parse_failed",
            "count": int(summary_df["parse_failed"].sum())
            if "parse_failed" in summary_df.columns
            else 0,
        },
        {
            "metric": "pages_audit_failed",
            "count": int(summary_df[AUDIT_FAILED_STATUS].sum())
            if AUDIT_FAILED_STATUS in summary_df.columns
            else 0,
        },
    ]
    summary_table = pd.DataFrame(summary_rows)
    print("PDF extraction summary:")
    print(summary_table.to_string(index=False))


def _print_concurrency_guidance(summary_df: pd.DataFrame, max_concurrent_files: int) -> None:
    """Give the analyst a simple signal about whether concurrency is stressing the APIs."""
    if summary_df.empty:
        return

    retry_events = (
        int(summary_df["retry_events"].sum()) if "retry_events" in summary_df.columns else 0
    )
    retryable_api_failures = (
        int(summary_df["retryable_api_failures"].sum())
        if "retryable_api_failures" in summary_df.columns
        else 0
    )
    message = (
        f"Concurrency check: max_concurrent_files={max_concurrent_files}, "
        f"processed_files={len(summary_df)}, retry_events={retry_events}, "
        f"retryable_api_failures={retryable_api_failures}. "
    )
    if retryable_api_failures > 0 or retry_events >= max(3, max_concurrent_files):
        print(
            message + "This run showed API pressure, so your max concurrency may be too high. "
            "If this keeps happening, try a smaller value."
        )
        return
    print(message + "No clear concurrency pressure was detected in this run.")


def _build_combined_file_output(
    data_location: Path,
    file_name: str,
    intended_columns: list[str],
) -> Path | None:
    """Create one combined CSV per PDF once all of its pages are valid."""
    extracted_files_dir = data_location / "extracted_files"
    extracted_files_dir.mkdir(exist_ok=True)
    combined_df = combine_extracted_pdf_pages(
        data_location=data_location,
        intended_columns=intended_columns,
        file_name=file_name,
    )
    if combined_df.empty:
        return None
    output_path = _combined_output_path(extracted_files_dir, file_name)
    combined_df.to_csv(output_path, index=False)
    return output_path


def _call_openai_prompt_with_metadata(
    OpenAI_client: Any,
    prompt: str,
    user_content: str | LLMWhispererClientException,
    *,
    model: str = DEFAULT_OPENAI_PDF_MODEL,
    max_retries: int = DEFAULT_API_MAX_RETRIES,
) -> dict[str, Any]:
    """Centralize OpenAI retries so markdown and JSON parsing behave consistently."""
    return shared_call_openai_prompt_with_metadata(
        openai_client=OpenAI_client,
        prompt=prompt,
        user_content=user_content,
        model=model,
        max_retries=max_retries,
    )


def _strip_markdown_code_fences(text: str) -> str:
    """LLMs sometimes wrap JSON in fences even when instructed not to."""
    stripped = (text or "").strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z0-9_-]*\n?", "", stripped)
        stripped = re.sub(r"\n?```$", "", stripped)
    return stripped.strip()


def _extract_json_blob(text: str) -> str:
    """Recover the JSON payload from a chat response without trusting exact formatting."""
    cleaned = _strip_markdown_code_fences(text)
    if cleaned.startswith("{") or cleaned.startswith("["):
        return cleaned
    first_object = cleaned.find("{")
    first_list = cleaned.find("[")
    starts = [position for position in [first_object, first_list] if position >= 0]
    if not starts:
        return cleaned
    start = min(starts)
    end = max(cleaned.rfind("}"), cleaned.rfind("]"))
    return cleaned[start : end + 1] if end > start else cleaned[start:]


def _looks_like_no_table_response(text: str) -> bool:
    """Return ``True`` when an LLM response signals no table was found.

    Args:
        text: Raw LLM response text.

    Returns:
        ``True`` if the response contains a known "no table" sentinel.
    """
    lowered = (text or "").strip().lower()
    return "no table found" in lowered or "no_table_detected" in lowered


def _build_json_rows_prompt(
    base_prompt: str,
    desired_columns: list[str],
    *,
    strict: bool,
    CBORD: bool,
) -> str:
    """Wrap the analyst-authored prompt in a deterministic JSON contract."""
    schema_fields = ", ".join([f'"{column}": string_or_number' for column in desired_columns])
    strict_clause = (
        "Reject rows that are missing required fields instead of inventing values."
        if strict
        else "Use best-effort parsing, but keep parse_notes explicit when a field is uncertain."
    )
    cbord_clause = (
        (
            "Because this is CBORD data, keep the schema strict and prefer failing the row "
            "over guessing."
        )
        if CBORD
        else (
            "This is non-CBORD data, so preserve analyst-selected columns without assuming "
            "a repo-wide schema."
        )
    )
    return (
        f"{base_prompt}\n\n"
        "Return only JSON. Do not return markdown, prose, or code fences.\n"
        "The JSON must be an object with exactly these top-level keys:\n"
        "{\n"
        '  "status": "ok" | "no_table_detected",\n'
        '  "rows": [\n'
        "    {\n"
        f"      {schema_fields},\n"
        '      "source_line_numbers": [int, ...],\n'
        '      "row_confidence": float,\n'
        '      "parse_notes": string\n'
        "    }\n"
        "  ]\n"
        "}\n"
        'If there is no table on the page, return {"status": "no_table_detected", "rows": []}.\n'
        f"{strict_clause}\n"
        f"{cbord_clause}\n"
    )


def _extract_native_pdf_text(pdf_path: Path, page: int) -> str:
    """Use PyPDF2 text as a cheap routing hint before spending API calls."""
    try:
        reader = PdfReader(pdf_path)
        return reader.pages[page - 1].extract_text() or ""
    except (OSError, IndexError, ValueError, KeyError) as exc:
        logging.debug("Native PDF text extraction failed for %s page %d: %s", pdf_path, page, exc)
        return ""


def _looks_table_like_native_text(text: str) -> bool:
    """Heuristic for distinguishing clean tabular PDFs from prose-heavy machine text."""
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    if not lines:
        return False
    digit_lines = sum(bool(re.search(r"\d", line)) for line in lines)
    short_lines = sum(len(line.split()) <= 6 for line in lines)
    separator_lines = sum(
        "  " in line or "\t" in line or "|" in line or re.search(r"\.{2,}", line) is not None
        for line in lines
    )
    line_count = len(lines)
    return (
        digit_lines / line_count >= 0.35
        and short_lines / line_count >= 0.35
        and separator_lines / line_count >= 0.20
    )


def _sample_tuning_pages(
    pdf_files: list[str],
    data_location: Path,
    *,
    sample_cap: int = DEFAULT_TUNING_SAMPLE_CAP,
    random_seed: int = DEFAULT_TUNING_RANDOM_SEED,
) -> list[dict[str, Any]]:
    """Implement the exact two-pass sampling rule from the refactor plan."""
    if sample_cap <= 0:
        return []

    rng = random.Random(random_seed)  # nosec B311 - deterministic test/data sampling only
    selected_pages: list[dict[str, Any]] = []
    used_pages: dict[str, set[int]] = {}

    for file_name in pdf_files:
        pdf_path = data_location / file_name
        if not pdf_path.exists():
            continue
        total_pages = _count_pages(pdf_path)
        if total_pages <= 0:
            continue
        page = rng.randint(1, total_pages)
        selected_pages.append({"file_name": file_name, "page": page})
        used_pages.setdefault(file_name, set()).add(page)
        if len(selected_pages) >= sample_cap:
            return selected_pages[:sample_cap]

    if len(selected_pages) >= sample_cap:
        return selected_pages[:sample_cap]

    shuffled_files = list(pdf_files)
    rng.shuffle(shuffled_files)
    for file_name in shuffled_files:
        pdf_path = data_location / file_name
        if not pdf_path.exists():
            continue
        total_pages = _count_pages(pdf_path)
        available_pages = [
            page
            for page in range(1, total_pages + 1)
            if page not in used_pages.get(file_name, set())
        ]
        if not available_pages:
            continue
        page = rng.choice(available_pages)
        selected_pages.append({"file_name": file_name, "page": page})
        used_pages.setdefault(file_name, set()).add(page)
        if len(selected_pages) >= sample_cap:
            break

    return selected_pages[:sample_cap]


def _score_tuning_text(extracted_text: str) -> float:
    """Use a lightweight text score for profile calibration before full parsing."""
    lines = [line.strip() for line in (extracted_text or "").splitlines() if line.strip()]
    if not lines:
        return 0.0
    digit_lines = sum(bool(re.search(r"\d", line)) for line in lines)
    structured_lines = sum(
        "|" in line or "\t" in line or "  " in line or re.search(r"\.{2,}", line) is not None
        for line in lines
    )
    average_line_length = sum(len(line) for line in lines) / len(lines)
    score = (
        min(len(lines) / 40, 1.0) * 0.35
        + min(digit_lines / len(lines), 1.0) * 0.30
        + min(structured_lines / len(lines), 1.0) * 0.25
        + min(average_line_length / 80, 1.0) * 0.10
    )
    return round(score, 4)


def _benchmark_digital_profiles(
    sample_pages: list[dict[str, Any]],
    *,
    data_location: Path,
    whisper_client: Any,
) -> dict[str, Any]:
    """Choose the preferred digital-PDF family using the sampled real pages."""
    if not sample_pages:
        return {
            "preferred_digital_profile": "table",
            "scores": {},
            "sample_pages": [],
        }

    profile_scores: dict[str, list[float]] = {"native_text": [], "table": []}
    for sample in sample_pages:
        for profile_name in profile_scores:
            result = _extract_pdf_text_whisper_with_metadata(
                file_path=str(data_location),
                file_name=sample["file_name"],
                whisper_client=whisper_client,
                page=str(sample["page"]),
                profile_name=profile_name,
                profile_settings=WHISPER_PROFILE_OPTIONS[profile_name],
            )
            profile_scores[profile_name].append(_score_tuning_text(str(result.get("text") or "")))

    average_scores = {
        profile_name: round(sum(scores) / len(scores), 4) if scores else 0.0
        for profile_name, scores in profile_scores.items()
    }
    preferred = max(average_scores.items(), key=lambda item: item[1])[0]
    return {
        "preferred_digital_profile": preferred,
        "scores": average_scores,
        "sample_pages": sample_pages,
    }


def _resolve_page_profile(
    *,
    pdf_path: Path,
    page: int,
    extraction_profile: str,
    preferred_digital_profile: str | None = None,
) -> str:
    """Route scanned pages to high-quality OCR and digital pages to the tuned digital profile."""
    normalized_profile = _normalize_extraction_profile(extraction_profile)
    if normalized_profile != "auto":
        return normalized_profile

    native_text = _extract_native_pdf_text(pdf_path, page)
    if not native_text or len(native_text.strip()) < 40:
        return "high_quality"

    if _looks_table_like_native_text(native_text):
        return preferred_digital_profile or "table"
    return preferred_digital_profile or "native_text"


def _choose_alternate_profiles(current_profile: str) -> list[str]:
    """Use a stable repair order so repeated runs explain themselves consistently."""
    repair_order = {
        "native_text": ["table", "high_quality"],
        "table": ["native_text", "high_quality"],
        "high_quality": ["table", "native_text"],
    }
    return repair_order.get(current_profile, ["table", "native_text", "high_quality"])


def _normalize_line_numbers(value: Any) -> list[int]:
    """Row provenance can arrive as ints, strings, or mixed lists depending on the parser."""
    if value is None:
        return []
    if isinstance(value, int):
        return [value]
    if isinstance(value, list):
        normalized: list[int] = []
        for item in value:
            normalized.extend(_normalize_line_numbers(item))
        return sorted(set(normalized))
    if isinstance(value, str):
        matches = re.findall(r"\d+", value)
        return sorted({int(match) for match in matches})
    return []


def _infer_source_line_numbers_from_text(product_name: str, extracted_text: str) -> list[int]:
    """Infer source evidence for markdown parsing by matching row names back to extracted text."""
    if not product_name:
        return []

    normalized_product = str(product_name).strip().lower()
    if not normalized_product:
        return []

    meaningful_tokens = [
        token for token in re.findall(r"[a-z0-9]+", normalized_product) if len(token) >= 3
    ]
    if not meaningful_tokens:
        return []

    exact_matches: list[int] = []
    partial_matches: list[int] = []
    for index, line in enumerate((extracted_text or "").splitlines(), start=1):
        normalized_line = line.lower()
        if normalized_product in normalized_line:
            exact_matches.append(index)
            continue
        matched_tokens = sum(token in normalized_line for token in meaningful_tokens)
        if matched_tokens >= max(1, min(2, len(meaningful_tokens))):
            partial_matches.append(index)

    if exact_matches:
        return exact_matches[:3]
    return partial_matches[:3]


def _build_row_provenance(
    page_df: pd.DataFrame,
    *,
    extracted_text: str,
    product_name_column: str,
    json_rows: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Always attach row provenance, even when markdown fallback is used."""
    if page_df.empty:
        return []

    provenance: list[dict[str, Any]] = []
    if json_rows:
        for row in json_rows:
            line_numbers = _normalize_line_numbers(row.get("source_line_numbers"))
            provenance.append(
                {
                    "source_line_numbers": line_numbers,
                    "row_confidence": float(row.get("row_confidence", 0.0) or 0.0),
                    "parse_notes": str(row.get("parse_notes", "") or ""),
                }
            )
        return provenance

    product_column = product_name_column.strip().lower()
    fallback_page_lines = [1] if (extracted_text or "").splitlines() else []
    for _, row in page_df.iterrows():
        product_value = str(row.get(product_column, "") or "")
        matched_line_numbers = _infer_source_line_numbers_from_text(product_value, extracted_text)
        line_numbers = matched_line_numbers or fallback_page_lines
        provenance.append(
            {
                "source_line_numbers": line_numbers,
                "row_confidence": 0.9 if matched_line_numbers else 0.35,
                "parse_notes": (
                    "source lines inferred from markdown fallback parser"
                    if matched_line_numbers
                    else (
                        "used page-level fallback evidence because row-specific line "
                        "matching was weak"
                    )
                ),
            }
        )
    return provenance


def _flatten_numeric_values(payload: Any) -> list[float]:
    """Confidence metadata is nested and provider-specific, so flatten it generically."""
    values: list[float] = []
    if isinstance(payload, dict):
        for value in payload.values():
            values.extend(_flatten_numeric_values(value))
    elif isinstance(payload, list):
        for value in payload:
            values.extend(_flatten_numeric_values(value))
    elif isinstance(payload, (int, float)):
        values.append(float(payload))
    return values


def _estimate_ocr_confidence(confidence_metadata: Any) -> float:
    """Return a 0-1 score even when the upstream metadata shape changes."""
    numeric_values = _flatten_numeric_values(confidence_metadata)
    if not numeric_values:
        return 0.5
    average_value = sum(numeric_values) / len(numeric_values)
    if average_value > 1:
        average_value = average_value / 100.0
    return max(0.0, min(1.0, average_value))


def _summarize_nulls(page_df: pd.DataFrame) -> dict[str, int]:
    """Return a per-column count of null values for a page DataFrame.

    Args:
        page_df: DataFrame produced for a single PDF page.

    Returns:
        Mapping of column name to null count, or an empty dict if the input is empty.
    """
    if page_df.empty:
        return {}
    return {column: int(page_df[column].isna().sum()) for column in page_df.columns}


def _build_parsed_preview(page_df: pd.DataFrame, limit: int = 3) -> str:
    """Build a JSON-encoded preview of the first rows of a page DataFrame.

    Args:
        page_df: DataFrame produced for a single PDF page.
        limit: Maximum number of rows to include in the preview.

    Returns:
        JSON string of the preview rows, or an empty string if the input is empty.
    """
    if page_df.empty:
        return ""
    return json.dumps(page_df.head(limit).to_dict(orient="records"), ensure_ascii=True)


def _audit_candidate(
    page_df: pd.DataFrame,
    *,
    desired_columns: list[str],
    numeric_columns: list[str],
    row_provenance: list[dict[str, Any]],
    confidence_metadata: Any,
    status: str,
    CBORD: bool,
    audit_threshold: float,
    visual_audit_threshold: float,
    candidate_source: str,
) -> dict[str, Any]:
    """Score candidates so the pipeline can prefer the best page outcome, not the first one."""
    if status == NO_TABLE_STATUS:
        return {
            "score": 1.0,
            "threshold": audit_threshold,
            "passed": True,
            "hard_failure": False,
            "failure_reasons": [],
            "components": {
                "required_completeness": 1.0,
                "numeric_and_date_parse": 1.0,
                "duplicate_quality": 1.0,
                "header_consistency": 1.0,
                "ocr_confidence": 1.0,
                "source_line_coverage": 1.0,
            },
        }

    if page_df.empty:
        return {
            "score": 0.0,
            "threshold": audit_threshold,
            "passed": False,
            "hard_failure": True,
            "failure_reasons": ["parsed dataframe is empty"],
            "components": {},
        }

    desired_columns_lower = standardize_columns(desired_columns)
    present_columns = set(page_df.columns.tolist())
    header_consistency = len(set(desired_columns_lower) & present_columns) / max(
        len(desired_columns_lower), 1
    )
    required_df = page_df[
        [column for column in desired_columns_lower if column in page_df.columns]
    ].copy()
    required_completeness = (
        1.0 - float(required_df.isna().mean().mean()) if not required_df.empty else 0.0
    )

    numeric_scores: list[float] = []
    for column in numeric_columns:
        if column in page_df.columns:
            numeric_scores.append(float(page_df[column].notna().mean()))
    numeric_parse_success = sum(numeric_scores) / len(numeric_scores) if numeric_scores else 1.0

    date_parse_success = 1.0
    failure_reasons: list[str] = []
    hard_failure = False
    if "date" in desired_columns_lower:
        if "date" not in page_df.columns:
            date_parse_success = 0.0
            failure_reasons.append("missing date column")
            if CBORD:
                hard_failure = True
        else:
            parsed_dates = pd.to_datetime(page_df["date"], errors="coerce")
            date_parse_success = float(parsed_dates.notna().mean()) if len(page_df) else 0.0
            if CBORD and page_df["date"].nunique(dropna=True) > 1:
                hard_failure = True
                failure_reasons.append("CBORD page has multiple dates")
            if CBORD and date_parse_success < 1.0:
                hard_failure = True
                failure_reasons.append("CBORD date parse failed")

    duplicate_quality = 1.0 - float(page_df.duplicated().mean()) if len(page_df) else 0.0
    source_line_coverage = (
        sum(bool(provenance.get("source_line_numbers")) for provenance in row_provenance)
        / len(row_provenance)
        if row_provenance
        else 0.0
    )
    ocr_confidence = _estimate_ocr_confidence(confidence_metadata)
    numeric_and_date_parse = (numeric_parse_success + date_parse_success) / 2

    weighted_score = (
        required_completeness * 0.25
        + numeric_and_date_parse * 0.25
        + duplicate_quality * 0.15
        + header_consistency * 0.15
        + ocr_confidence * 0.10
        + source_line_coverage * 0.10
    )

    if required_completeness < 0.90:
        failure_reasons.append("required columns contain nulls")
    if numeric_and_date_parse < 0.90:
        failure_reasons.append("numeric/date parse quality is low")
    if duplicate_quality < 0.90:
        failure_reasons.append("duplicate rows detected")
    if source_line_coverage < 0.60:
        failure_reasons.append("insufficient source line coverage")

    threshold = visual_audit_threshold if candidate_source == "gemini" else audit_threshold
    passed = weighted_score >= threshold and not hard_failure
    return {
        "score": round(weighted_score, 4),
        "threshold": threshold,
        "passed": passed,
        "hard_failure": hard_failure,
        "failure_reasons": failure_reasons,
        "components": {
            "required_completeness": round(required_completeness, 4),
            "numeric_and_date_parse": round(numeric_and_date_parse, 4),
            "duplicate_quality": round(duplicate_quality, 4),
            "header_consistency": round(header_consistency, 4),
            "ocr_confidence": round(ocr_confidence, 4),
            "source_line_coverage": round(source_line_coverage, 4),
        },
    }


def _choose_best_candidate(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    """Pick the best page candidate by audit score, then by completion status."""
    if not candidates:
        return {}
    ranked = sorted(
        candidates,
        key=lambda candidate: (
            candidate.get("audit", {}).get("passed", False),
            candidate.get("audit", {}).get("score", 0.0),
            candidate.get("status") in COMPLETED_PAGE_STATUSES,
        ),
        reverse=True,
    )
    return ranked[0]


def _build_page_status(
    *,
    page: int,
    status: str,
    error: str,
    output_path: Path,
    retry_count: int,
    retryable: bool,
    audit: dict[str, Any] | None = None,
    metadata_path: Path | None = None,
) -> dict[str, Any]:
    """Use one helper for page statuses so file summaries stay predictable."""
    return {
        "page": page,
        "status": status,
        "error": error,
        "output_path": str(output_path),
        "retry_count": retry_count,
        "retryable": retryable,
        "audit_score": audit.get("score") if audit else None,
        "metadata_path": str(metadata_path) if metadata_path else "",
    }


def _extract_pdf_text_whisper_with_metadata(
    file_path: str,
    file_name: str,
    whisper_client: Any,
    page: str | int,
    profile_name: str = "high_quality",
    profile_settings: dict[str, Any] | None = None,
    max_retries: int = DEFAULT_API_MAX_RETRIES,
) -> dict[str, Any]:
    """Extract PDF text with retry metadata so callers can spot upstream pressure."""
    resolved_profile = profile_settings or WHISPER_PROFILE_OPTIONS.get(
        profile_name, WHISPER_PROFILE_OPTIONS["high_quality"]
    )
    return shared_extract_pdf_text_whisper_with_metadata(
        file_path=file_path,
        file_name=file_name,
        whisper_client=whisper_client,
        page=page,
        profile_name=profile_name,
        profile_settings=resolved_profile,
        max_retries=max_retries,
    )


def _clean_parsed_page_df(
    page_df: pd.DataFrame,
    *,
    desired_columns: list[str] | None,
    numeric_columns: list[str] | None,
    product_name_column: str,
    debug: bool,
    enforce_product_null_threshold: bool,
    drop_all_null_columns: bool,
    empty_after_cleaning_message: str | None = None,
) -> pd.DataFrame:
    """Apply the shared post-parse cleanup contract for markdown and JSON-row parsing."""
    cleaned_df = page_df.copy()
    cleaned_df.columns = standardize_columns(cleaned_df.columns.tolist())

    unnamed_columns = [column for column in cleaned_df.columns if column.startswith("unnamed:")]
    if unnamed_columns:
        cleaned_df = cleaned_df.drop(columns=unnamed_columns)

    for column in cleaned_df.columns:
        if cleaned_df[column].dtype == "object":
            cleaned_df[column] = cleaned_df[column].map(
                lambda value: value.strip() if isinstance(value, str) else value
            )

    product_name_column_lower = product_name_column.strip().lower() if product_name_column else None
    if product_name_column_lower and product_name_column_lower in cleaned_df.columns:
        if enforce_product_null_threshold:
            assert cleaned_df[product_name_column_lower].isnull().mean() < 0.1, (
                "Product name column is over 10% null. Check the extraction."
            )
        cleaned_df[product_name_column_lower] = (
            cleaned_df[product_name_column_lower].astype(str).str.strip()
        )
        cleaned_df = cleaned_df.loc[
            ~cleaned_df[product_name_column_lower].str.fullmatch(r"-+"),
            :,
        ]
    elif debug:
        print(
            f"Debug: Product name column '{product_name_column}' not found. "
            "Skipping operations dependent on it."
        )

    if drop_all_null_columns:
        null_columns = cleaned_df.columns[cleaned_df.isnull().all()].tolist()
        if null_columns and debug:
            print(f"The following columns are full of nulls and so will be deleted: {null_columns}")
        cleaned_df = cleaned_df.dropna(axis=1, how="all")

    if desired_columns:
        desired_columns_lower = standardize_columns(desired_columns)
        missing_desired = set(desired_columns_lower) - set(cleaned_df.columns)
        assert not missing_desired, (
            f"Desired columns {missing_desired} are not in the dataframe after cleaning. "
            f"Available columns: {cleaned_df.columns.tolist()}"
        )
        cleaned_df = cleaned_df[desired_columns_lower]

    if numeric_columns:
        for column in standardize_columns(numeric_columns):
            if column in cleaned_df.columns:
                cleaned_series = cleaned_df[column].map(
                    lambda value: (
                        value.replace(",", "").strip() if isinstance(value, str) else value
                    )
                )
                cleaned_df[column] = pd.to_numeric(cleaned_series, errors="coerce")
                if debug:
                    print(f"Converted column '{column}' to numeric type.")

    cleaned_df = cleaned_df.dropna(axis=0, how="all")
    if cleaned_df.empty and empty_after_cleaning_message is not None:
        raise AssertionError(empty_after_cleaning_message)

    return cleaned_df


def _structured_rows_to_df(
    rows: list[dict[str, Any]],
    *,
    desired_columns: list[str],
    numeric_columns: list[str],
    product_name_column: str,
    debug: bool,
) -> pd.DataFrame:
    """Convert structured JSON rows into the same cleaned dataframe contract as markdown parsing."""
    if not rows:
        return pd.DataFrame(columns=standardize_columns(desired_columns))

    normalized_rows: list[dict[str, Any]] = []
    for row in rows:
        normalized_rows.append({str(key).strip().lower(): value for key, value in row.items()})

    page_df = pd.DataFrame(normalized_rows)
    if page_df.empty:
        return pd.DataFrame(columns=standardize_columns(desired_columns))

    return _clean_parsed_page_df(
        page_df,
        desired_columns=desired_columns,
        numeric_columns=numeric_columns,
        product_name_column=product_name_column,
        debug=debug,
        enforce_product_null_threshold=False,
        drop_all_null_columns=False,
    )


def _parse_json_rows_response(
    processed_text: str,
    *,
    desired_columns: list[str],
    numeric_columns: list[str],
    product_name_column: str,
    debug: bool,
) -> dict[str, Any]:
    """Parse the structured JSON-row response used by CBORD and repair flows."""
    json_blob = _extract_json_blob(processed_text)
    payload = json.loads(json_blob)
    if isinstance(payload, list):
        payload = {"status": "ok", "rows": payload}
    if not isinstance(payload, dict):
        raise AssertionError("Structured parser did not return a JSON object.")

    status = str(payload.get("status", "ok"))
    rows = payload.get("rows", [])
    if status == NO_TABLE_STATUS or status == "no_table_detected":
        return {
            "status": NO_TABLE_STATUS,
            "page_df": pd.DataFrame(columns=standardize_columns(desired_columns)),
            "json_rows": [],
        }
    if not isinstance(rows, list):
        raise AssertionError("Structured parser returned non-list rows.")

    page_df = _structured_rows_to_df(
        rows=rows,
        desired_columns=desired_columns,
        numeric_columns=numeric_columns,
        product_name_column=product_name_column,
        debug=debug,
    )
    return {
        "status": "processed",
        "page_df": page_df,
        "json_rows": rows,
    }


def _build_pipeline_context(
    *,
    whisper_client: Any,
    OpenAI_client: Any,
    data_location: Path,
    file_name: str,
    product_name_column: str,
    desired_columns: list[str],
    numeric_columns: list[str],
    parse_extracted_pdf_prompt: str,
    debug: bool,
    CBORD: bool,
    save_debug_artifacts: bool,
    extraction_profile: str,
    parser_mode: str,
    auto_repair: bool,
    enable_gemini_fallback: bool,
    gemini_client: Any,
    max_repair_attempts: int,
    audit_threshold: float,
    visual_audit_threshold: float,
    persist_audit_manifest: bool,
    preferred_digital_profile: str | None,
) -> dict[str, Any]:
    """Build one explicit context object so architectural choices are traceable in one place."""
    resolved_parser_mode = _normalize_parser_mode(parser_mode, CBORD)
    normalized_extraction_profile = _normalize_extraction_profile(extraction_profile)
    settings_signature = _build_run_settings_signature(
        desired_columns=desired_columns,
        numeric_columns=numeric_columns,
        parse_extracted_pdf_prompt=parse_extracted_pdf_prompt,
        parser_mode=resolved_parser_mode,
        extraction_profile=normalized_extraction_profile,
        CBORD=CBORD,
        audit_threshold=audit_threshold,
        visual_audit_threshold=visual_audit_threshold,
        enable_gemini_fallback=enable_gemini_fallback,
        max_repair_attempts=max_repair_attempts,
    )
    return {
        "whisper_client": whisper_client,
        "OpenAI_client": OpenAI_client,
        "gemini_client": gemini_client,
        "data_location": data_location,
        "file_name": file_name,
        "product_name_column": product_name_column,
        "desired_columns": desired_columns,
        "numeric_columns": numeric_columns,
        "parse_extracted_pdf_prompt": parse_extracted_pdf_prompt,
        "debug": debug,
        "CBORD": CBORD,
        "save_debug_artifacts": save_debug_artifacts,
        "extraction_profile": normalized_extraction_profile,
        "parser_mode": resolved_parser_mode,
        "auto_repair": auto_repair,
        "enable_gemini_fallback": enable_gemini_fallback,
        "max_repair_attempts": max_repair_attempts,
        "audit_threshold": audit_threshold,
        "visual_audit_threshold": visual_audit_threshold,
        "persist_audit_manifest": persist_audit_manifest,
        "preferred_digital_profile": preferred_digital_profile,
        "settings_signature": settings_signature,
        "prompt_hash": _prompt_hash(parse_extracted_pdf_prompt),
    }


def _candidate_needs_repair(candidate: dict[str, Any]) -> bool:
    """Return ``True`` if a parser candidate did not produce an acceptable result.

    Args:
        candidate: Candidate result dictionary produced by the parser pipeline.

    Returns:
        ``True`` when the candidate is empty, did not complete, or failed audit.
    """
    if not candidate:
        return True
    if candidate.get("status") not in COMPLETED_PAGE_STATUSES:
        return True
    return not candidate.get("audit", {}).get("passed", False)


def _run_parser_candidate(
    *,
    page: int,
    context: dict[str, Any],
    profile_name: str,
    parser_mode: str,
    candidate_name: str,
    whisper_result_override: dict[str, Any] | None = None,
    extracted_text_override: str | None = None,
) -> dict[str, Any]:
    """Run one parse candidate so audit manifests can compare like-for-like attempts."""
    data_location = context["data_location"]
    file_name = context["file_name"]
    output_file_path = _page_output_path(data_location / "extracted_pages", file_name, page)

    whisper_result = whisper_result_override
    if whisper_result is None:
        whisper_result = _extract_pdf_text_whisper_with_metadata(
            file_path=str(data_location),
            file_name=file_name,
            whisper_client=context["whisper_client"],
            page=str(page),
            profile_name=profile_name,
            profile_settings=WHISPER_PROFILE_OPTIONS[profile_name],
        )

    extracted_text = (
        extracted_text_override if extracted_text_override is not None else whisper_result["text"]
    )
    whisper_failure_kind = str(whisper_result.get("failure_kind", "") or "")
    debug_suffix = "" if candidate_name.startswith("initial_") else f"_{candidate_name}"
    _write_debug_artifact(
        data_location=data_location,
        filename=(
            f"LLM_Whisper_extracted_text_{Path(file_name).stem}_page_{page}"
            f"{debug_suffix}_debugging.md"
        ),
        content=(
            (
                f"{whisper_result.get('error_type', 'LLMWhispererClientException')}: "
                f"{whisper_result.get('error', '')}"
            )
            if whisper_failure_kind == "api_failed"
            else (extracted_text or "")
        ),
        save_debug_artifacts=context["save_debug_artifacts"],
    )

    retry_count = max(0, whisper_result.get("attempts", 1) - 1)
    if whisper_failure_kind == "api_failed":
        whisper_error = whisper_result.get("error") or "unknown LLMWhisperer error"
        print(
            f"Error extracting file {Path(file_name).name} page {page} "
            f"(candidate={candidate_name}, profile={profile_name}): {whisper_error}."
        )
        return {
            "candidate_name": candidate_name,
            "status": "api_failed",
            "error": f"extraction error from LLMWhisperer ({whisper_error})",
            "retry_count": retry_count,
            "retryable": whisper_result.get("retryable", False),
            "output_path": output_file_path,
            "profile_name": profile_name,
            "parser_mode": parser_mode,
            "raw_text": "",
            "processed_text": "",
            "page_df": pd.DataFrame(),
            "saved_df": pd.DataFrame(),
            "row_provenance": [],
            "audit": {"score": 0.0, "passed": False, "failure_reasons": [whisper_error]},
            "whisper_result": whisper_result,
        }
    if not extracted_text:
        no_text_error = whisper_result.get("error") or "no text extracted"
        print(
            f"No text extracted from file {Path(file_name).name} page {page} "
            f"(candidate={candidate_name}, profile={profile_name}). {no_text_error}"
        )
        return {
            "candidate_name": candidate_name,
            "status": "no_text",
            "error": no_text_error,
            "retry_count": retry_count,
            "retryable": False,
            "output_path": output_file_path,
            "profile_name": profile_name,
            "parser_mode": parser_mode,
            "raw_text": "",
            "processed_text": "",
            "page_df": pd.DataFrame(),
            "saved_df": pd.DataFrame(),
            "row_provenance": [],
            "audit": {"score": 0.0, "passed": False, "failure_reasons": [no_text_error]},
            "whisper_result": whisper_result,
        }

    if parser_mode == "json_rows":
        prompt = _build_json_rows_prompt(
            context["parse_extracted_pdf_prompt"],
            context["desired_columns"],
            strict=candidate_name != "initial_markdown",
            CBORD=context["CBORD"],
        )
        llm_result = _call_openai_prompt_with_metadata(
            OpenAI_client=context["OpenAI_client"],
            prompt=prompt,
            user_content=extracted_text,
        )
    else:
        llm_result = _call_openai_prompt_with_metadata(
            OpenAI_client=context["OpenAI_client"],
            prompt=context["parse_extracted_pdf_prompt"],
            user_content=extracted_text,
        )

    processed_text = llm_result["processed_text"]
    if processed_text:
        extension = "json" if parser_mode == "json_rows" else "md"
        _write_debug_artifact(
            data_location=data_location,
            filename=(
                f"LLM_Whisper_processed_text_{Path(file_name).stem}_page_{page}"
                f"{debug_suffix}_debugging.{extension}"
            ),
            content=processed_text,
            save_debug_artifacts=context["save_debug_artifacts"],
        )

    retry_count += max(0, llm_result.get("attempts", 1) - 1)
    if not processed_text:
        print(
            f"No text processed by LLM for file {Path(file_name).name} page {page} "
            f"(candidate={candidate_name}, profile={profile_name}, parser_mode={parser_mode})."
        )
        status = "api_failed" if llm_result["retryable"] else "llm_empty"
        return {
            "candidate_name": candidate_name,
            "status": status,
            "error": llm_result["error"] or "no text processed by LLM",
            "retry_count": retry_count,
            "retryable": llm_result["retryable"],
            "output_path": output_file_path,
            "profile_name": profile_name,
            "parser_mode": parser_mode,
            "raw_text": extracted_text,
            "processed_text": "",
            "page_df": pd.DataFrame(),
            "saved_df": pd.DataFrame(),
            "row_provenance": [],
            "audit": {
                "score": 0.0,
                "passed": False,
                "failure_reasons": [llm_result["error"] or "empty parser result"],
            },
            "whisper_result": whisper_result,
            "model": llm_result.get("model", DEFAULT_OPENAI_PDF_MODEL),
        }

    try:
        json_rows: list[dict[str, Any]] | None = None
        if parser_mode == "json_rows":
            parsed = _parse_json_rows_response(
                processed_text=processed_text,
                desired_columns=context["desired_columns"],
                numeric_columns=context["numeric_columns"],
                product_name_column=context["product_name_column"],
                debug=context["debug"],
            )
            status = parsed["status"]
            page_df = parsed["page_df"]
            json_rows = parsed["json_rows"]
        else:
            if _looks_like_no_table_response(processed_text):
                status = NO_TABLE_STATUS
                page_df = pd.DataFrame(columns=context["desired_columns"])
            else:
                status = "processed"
                page_df = markdown_to_df(
                    markdown=processed_text,
                    numeric_columns=context["numeric_columns"],
                    product_name_column=context["product_name_column"],
                    desired_columns=context["desired_columns"],
                    debug=context["debug"],
                )

        row_provenance = _build_row_provenance(
            page_df,
            extracted_text=str(extracted_text),
            product_name_column=context["product_name_column"],
            json_rows=json_rows,
        )
        audit = _audit_candidate(
            page_df,
            desired_columns=context["desired_columns"],
            numeric_columns=context["numeric_columns"],
            row_provenance=row_provenance,
            confidence_metadata=whisper_result.get("confidence_metadata", {}),
            status=status,
            CBORD=context["CBORD"],
            audit_threshold=context["audit_threshold"],
            visual_audit_threshold=context["visual_audit_threshold"],
            candidate_source="gemini" if candidate_name.startswith("gemini") else "openai",
        )

        saved_df = page_df.copy()
        if not saved_df.empty:
            saved_df["page"] = page
            saved_df["original_file"] = Path(file_name).name
            if context["CBORD"]:
                validate_cbord_date_column(saved_df, page, file_name, context["debug"])

        return {
            "candidate_name": candidate_name,
            "status": status,
            "error": "" if status in COMPLETED_PAGE_STATUSES else "candidate did not complete",
            "retry_count": retry_count,
            "retryable": False,
            "output_path": output_file_path,
            "profile_name": profile_name,
            "parser_mode": parser_mode,
            "raw_text": str(extracted_text),
            "processed_text": processed_text,
            "page_df": page_df,
            "saved_df": saved_df,
            "row_provenance": row_provenance,
            "audit": audit,
            "whisper_result": whisper_result,
            "model": llm_result.get("model", DEFAULT_OPENAI_PDF_MODEL),
            "whisper_hash": whisper_result.get("whisper_hash", ""),
            "confidence_metadata": whisper_result.get("confidence_metadata", {}),
        }
    except Exception as exception:
        if context["debug"]:
            print("Processed text that caused error:\n", processed_text)
        return {
            "candidate_name": candidate_name,
            "status": "parse_failed",
            "error": f"dataframe conversion/save error ({exception})",
            "retry_count": retry_count,
            "retryable": False,
            "output_path": output_file_path,
            "profile_name": profile_name,
            "parser_mode": parser_mode,
            "raw_text": str(extracted_text),
            "processed_text": processed_text,
            "page_df": pd.DataFrame(),
            "saved_df": pd.DataFrame(),
            "row_provenance": [],
            "audit": {"score": 0.0, "passed": False, "failure_reasons": [str(exception)]},
            "whisper_result": whisper_result,
            "model": llm_result.get("model", DEFAULT_OPENAI_PDF_MODEL),
        }


def _run_gemini_candidate(
    *,
    page: int,
    context: dict[str, Any],
    candidate_name: str = "gemini_visual_fallback",
) -> dict[str, Any]:
    """Gemini is the last repair rung, not the primary path."""
    output_file_path = _page_output_path(
        context["data_location"] / "extracted_pages", context["file_name"], page
    )
    gemini_client = context.get("gemini_client")
    if gemini_client is None:
        return {
            "candidate_name": candidate_name,
            "status": "parse_failed",
            "error": "Gemini fallback requested but gemini_client was not provided",
            "retry_count": 0,
            "retryable": False,
            "output_path": output_file_path,
            "profile_name": "gemini_pdf_upload",
            "parser_mode": "json_rows",
            "raw_text": "",
            "processed_text": "",
            "page_df": pd.DataFrame(),
            "saved_df": pd.DataFrame(),
            "row_provenance": [],
            "audit": {"score": 0.0, "passed": False, "failure_reasons": ["missing gemini client"]},
        }

    pdf_path = str(context["data_location"] / context["file_name"])
    prompt = (
        _build_json_rows_prompt(
            context["parse_extracted_pdf_prompt"],
            context["desired_columns"],
            strict=True,
            CBORD=context["CBORD"],
        )
        + f"\nOnly extract page {page} from the PDF.\n"
    )

    gemini_result = call_gemini_pdf_upload_with_metadata(
        gemini_client=gemini_client,
        pdf_path=pdf_path,
        prompt=prompt,
        model=GEMINI_VISUAL_FALLBACK_MODEL,
        max_retries=DEFAULT_API_MAX_RETRIES,
    )
    if gemini_result["error"]:
        return {
            "candidate_name": candidate_name,
            "status": "parse_failed",
            "error": gemini_result["error"],
            "retry_count": max(0, gemini_result["attempts"] - 1),
            "retryable": gemini_result["retryable"],
            "output_path": output_file_path,
            "profile_name": "gemini_pdf_upload",
            "parser_mode": "json_rows",
            "raw_text": "",
            "processed_text": "",
            "page_df": pd.DataFrame(),
            "saved_df": pd.DataFrame(),
            "row_provenance": [],
            "audit": {"score": 0.0, "passed": False, "failure_reasons": [gemini_result["error"]]},
            "model": gemini_result["model"],
        }

    try:
        processed_text = gemini_result["processed_text"]
        parsed = _parse_json_rows_response(
            processed_text=processed_text,
            desired_columns=context["desired_columns"],
            numeric_columns=context["numeric_columns"],
            product_name_column=context["product_name_column"],
            debug=context["debug"],
        )
        row_provenance = _build_row_provenance(
            parsed["page_df"],
            extracted_text=processed_text,
            product_name_column=context["product_name_column"],
            json_rows=parsed["json_rows"],
        )
        audit = _audit_candidate(
            parsed["page_df"],
            desired_columns=context["desired_columns"],
            numeric_columns=context["numeric_columns"],
            row_provenance=row_provenance,
            confidence_metadata={},
            status=parsed["status"],
            CBORD=context["CBORD"],
            audit_threshold=context["audit_threshold"],
            visual_audit_threshold=context["visual_audit_threshold"],
            candidate_source="gemini",
        )
        saved_df = parsed["page_df"].copy()
        if not saved_df.empty:
            saved_df["page"] = page
            saved_df["original_file"] = Path(context["file_name"]).name
        return {
            "candidate_name": candidate_name,
            "status": parsed["status"],
            "error": "",
            "retry_count": max(0, gemini_result["attempts"] - 1),
            "retryable": False,
            "output_path": output_file_path,
            "profile_name": "gemini_pdf_upload",
            "parser_mode": "json_rows",
            "raw_text": processed_text,
            "processed_text": processed_text,
            "page_df": parsed["page_df"],
            "saved_df": saved_df,
            "row_provenance": row_provenance,
            "audit": audit,
            "model": gemini_result["model"],
            "whisper_hash": "",
            "confidence_metadata": {},
        }
    except Exception as exception:
        return {
            "candidate_name": candidate_name,
            "status": "parse_failed",
            "error": f"Gemini fallback parsing failed ({exception})",
            "retry_count": 0,
            "retryable": False,
            "output_path": output_file_path,
            "profile_name": "gemini_pdf_upload",
            "parser_mode": "json_rows",
            "raw_text": "",
            "processed_text": "",
            "page_df": pd.DataFrame(),
            "saved_df": pd.DataFrame(),
            "row_provenance": [],
            "audit": {"score": 0.0, "passed": False, "failure_reasons": [str(exception)]},
        }


def _persist_page_artifacts(
    *,
    page: int,
    context: dict[str, Any],
    winner: dict[str, Any],
    candidates: list[dict[str, Any]],
    reused_checkpoint: bool = False,
) -> None:
    """Persist both the winning output and the evidence that explains why it won."""
    data_location = context["data_location"]
    file_name = context["file_name"]
    output_file_path = _page_output_path(data_location / "extracted_pages", file_name, page)
    metadata_path = _page_metadata_path(data_location, file_name, page)
    audit_path = _page_audit_manifest_path(data_location, file_name, page)

    if winner["status"] == "processed":
        winner["saved_df"].to_csv(output_file_path, index=False)
    elif winner["status"] == NO_TABLE_STATUS and output_file_path.exists():
        output_file_path.unlink()

    metadata_payload = {
        "file_name": Path(file_name).name,
        "page": page,
        "status": winner["status"],
        "reused_checkpoint": reused_checkpoint,
        "selected_candidate": winner.get("candidate_name", ""),
        "selected_profile": winner.get("profile_name", ""),
        "parser_mode": winner.get("parser_mode", context["parser_mode"]),
        "prompt_hash": context["prompt_hash"],
        "settings_signature": context["settings_signature"],
        "chosen_columns": context["desired_columns"],
        "numeric_columns": context["numeric_columns"],
        "model": winner.get("model", DEFAULT_OPENAI_PDF_MODEL),
        "whisper_hash": winner.get("whisper_hash", ""),
        "audit": winner.get("audit", {}),
        "row_provenance": winner.get("row_provenance", []),
        "raw_text_preview": _summarize_text(winner.get("raw_text", "")),
        "parsed_preview": _build_parsed_preview(winner.get("page_df", pd.DataFrame())),
        "null_summary": _summarize_nulls(winner.get("page_df", pd.DataFrame())),
    }
    _write_json_artifact(metadata_path, metadata_payload)

    if context["persist_audit_manifest"]:
        audit_payload = {
            "file_name": Path(file_name).name,
            "page": page,
            "selected_winner": winner.get("candidate_name", ""),
            "candidate_scores": [
                {
                    "candidate_name": candidate.get("candidate_name", ""),
                    "status": candidate.get("status", ""),
                    "profile_name": candidate.get("profile_name", ""),
                    "parser_mode": candidate.get("parser_mode", ""),
                    "audit_score": candidate.get("audit", {}).get("score"),
                    "audit_passed": candidate.get("audit", {}).get("passed"),
                    "failure_reasons": candidate.get("audit", {}).get("failure_reasons", []),
                    "error": candidate.get("error", ""),
                }
                for candidate in candidates
            ],
        }
        _write_json_artifact(audit_path, audit_payload)


def _existing_checkpoint_status(
    page: int, context: dict[str, Any], validate_existing_outputs: bool
) -> dict[str, Any] | None:
    """Reuse page outputs only when both the CSV and the sidecar agree on the run settings."""
    data_location = context["data_location"]
    file_name = context["file_name"]
    output_file_path = _page_output_path(data_location / "extracted_pages", file_name, page)
    metadata_path = _page_metadata_path(data_location, file_name, page)
    expected_columns = context["desired_columns"] + ["page", "original_file"]

    if not output_file_path.exists() and not metadata_path.exists():
        return None

    if validate_existing_outputs:
        if not _validate_existing_page_output(
            output_file_path,
            expected_columns,
            metadata_path=metadata_path,
            expected_settings_signature=context["settings_signature"],
        ):
            return None
    elif (
        not output_file_path.exists()
        and _read_json_artifact(metadata_path).get("status") != NO_TABLE_STATUS
    ):
        return None

    metadata = _read_json_artifact(metadata_path)
    existing_status = metadata.get("status", "skipped_existing")
    if existing_status == NO_TABLE_STATUS:
        return _build_page_status(
            page=page,
            status=NO_TABLE_STATUS,
            error="",
            output_path=output_file_path,
            retry_count=0,
            retryable=False,
            audit=metadata.get("audit", {}),
            metadata_path=metadata_path,
        )
    return _build_page_status(
        page=page,
        status="skipped_existing",
        error="",
        output_path=output_file_path,
        retry_count=0,
        retryable=False,
        audit=metadata.get("audit", {}),
        metadata_path=metadata_path,
    )


def _process_pdf_page(
    page: int,
    context: dict[str, Any],
    *,
    validate_existing_outputs: bool,
    force_reprocess: bool = False,
    persist_outputs: bool = True,
) -> dict[str, Any]:
    """Handle one page end-to-end, including audit and repair, while keeping outputs explainable."""
    data_location = context["data_location"]
    file_name = context["file_name"]
    output_file_path = _page_output_path(data_location / "extracted_pages", file_name, page)
    metadata_path = _page_metadata_path(data_location, file_name, page)

    if not force_reprocess:
        existing_status = _existing_checkpoint_status(page, context, validate_existing_outputs)
        if existing_status is not None:
            if context["debug"]:
                print(f"Page {page} already has a reusable checkpoint, skipping.")
            return existing_status

    if context["debug"]:
        print(f"Processing page {page}...")

    selected_profile = _resolve_page_profile(
        pdf_path=data_location / file_name,
        page=page,
        extraction_profile=context["extraction_profile"],
        preferred_digital_profile=context["preferred_digital_profile"],
    )
    candidates = [
        _run_parser_candidate(
            page=page,
            context=context,
            profile_name=selected_profile,
            parser_mode=context["parser_mode"],
            candidate_name=f"initial_{context['parser_mode']}",
        )
    ]

    if context["auto_repair"] and _candidate_needs_repair(candidates[0]):
        repair_count = 0
        initial_candidate = candidates[0]

        if initial_candidate.get("raw_text"):
            repair_count += 1
            candidates.append(
                _run_parser_candidate(
                    page=page,
                    context=context,
                    profile_name=selected_profile,
                    parser_mode="json_rows",
                    candidate_name="same_text_structured_reparse",
                    whisper_result_override=initial_candidate.get("whisper_result"),
                    extracted_text_override=initial_candidate.get("raw_text"),
                )
            )

        for alternate_profile in _choose_alternate_profiles(selected_profile):
            if repair_count >= context["max_repair_attempts"]:
                break
            repair_count += 1
            candidates.append(
                _run_parser_candidate(
                    page=page,
                    context=context,
                    profile_name=alternate_profile,
                    parser_mode=context["parser_mode"]
                    if context["parser_mode"] == "json_rows"
                    else "json_rows",
                    candidate_name=f"profile_repair_{alternate_profile}",
                )
            )

        if context["enable_gemini_fallback"] and all(
            _candidate_needs_repair(candidate) for candidate in candidates
        ):
            candidates.append(
                _run_gemini_candidate(
                    page=page,
                    context=context,
                )
            )

    winner = _choose_best_candidate(candidates)
    if winner.get("candidate_name") != candidates[0].get("candidate_name"):
        print(
            f"Recovered file {Path(file_name).name} page {page}: selected "
            f"{winner.get('candidate_name', '')} (profile={winner.get('profile_name', '')}, "
            f"parser_mode={winner.get('parser_mode', '')}, status={winner.get('status', '')}) "
            f"after initial candidate {candidates[0].get('candidate_name', '')} "
            f"(status={candidates[0].get('status', '')})."
        )
    if persist_outputs:
        _persist_page_artifacts(
            page=page,
            context=context,
            winner=winner,
            candidates=candidates,
        )

    if winner.get("status") in COMPLETED_PAGE_STATUSES and winner.get("audit", {}).get(
        "passed", False
    ):
        result = _build_page_status(
            page=page,
            status=winner["status"],
            error="",
            output_path=output_file_path,
            retry_count=winner.get("retry_count", 0),
            retryable=False,
            audit=winner.get("audit", {}),
            metadata_path=metadata_path if persist_outputs else None,
        )
    elif winner.get("status") in COMPLETED_PAGE_STATUSES:
        failure_reasons = winner.get("audit", {}).get("failure_reasons", [])
        result = _build_page_status(
            page=page,
            status=AUDIT_FAILED_STATUS,
            error="; ".join(failure_reasons) or "candidate failed audit threshold",
            output_path=output_file_path,
            retry_count=winner.get("retry_count", 0),
            retryable=False,
            audit=winner.get("audit", {}),
            metadata_path=metadata_path if persist_outputs else None,
        )
    else:
        result = _build_page_status(
            page=page,
            status=winner.get("status", "parse_failed"),
            error=winner.get("error", "page processing failed"),
            output_path=output_file_path,
            retry_count=winner.get("retry_count", 0),
            retryable=winner.get("retryable", False),
            audit=winner.get("audit", {}),
            metadata_path=metadata_path if persist_outputs else None,
        )

    # These preview fields power notebook preflight without forcing analysts to inspect JSON
    # sidecars.
    result["selected_profile"] = winner.get("profile_name", selected_profile)
    result["parser_mode"] = winner.get("parser_mode", context["parser_mode"])
    result["raw_extracted_text_preview"] = _summarize_text(winner.get("raw_text", ""))
    result["parsed_preview"] = _build_parsed_preview(winner.get("page_df", pd.DataFrame()))
    result["null_summary"] = json.dumps(
        _summarize_nulls(winner.get("page_df", pd.DataFrame())), ensure_ascii=True
    )
    result["candidate_scores"] = json.dumps(
        {
            candidate.get("candidate_name", ""): candidate.get("audit", {}).get("score")
            for candidate in candidates
        },
        ensure_ascii=True,
    )
    return result


# ----------------------------------------------------------------------
# Extract: PDF processing funcs
# ----------------------------------------------------------------------


def validate_cbord_date_column(
    page_df: pd.DataFrame, page: int, file_name: str, debug: bool = False
) -> None:
    """
    Validates CBORD-specific requirements for the date column in extracted PDF data.

    This function performs two validation checks:
    1. Warns if any date values are set to "missing"
    2. Warns if the date column contains multiple unique dates (expects 1 date per file)

    Args:
        page_df: DataFrame containing the extracted data for a single page
        page: Page number being validated
        file_name: Name of the PDF file being processed
        debug: If True, prints additional debugging information

    Returns:
        None. Prints warnings but does not raise exceptions.
    """
    if "date" not in page_df.columns:
        print(
            f"WARNING: Page {page} of {Path(file_name).name} is missing the 'date' column "
            "(CBORD validation skipped)"
        )
        return

    # Check if date column contains "missing" values
    missing_dates = page_df["date"].astype(str).str.lower().str.contains("missing", na=False)
    if missing_dates.any():
        print(
            f"WARNING: Page {page} of {Path(file_name).name} has {missing_dates.sum()} row(s) "
            "with date set to 'missing'"
        )

    # Check if all dates on this page are the same (unique per file requirement)
    unique_dates = page_df["date"].nunique()
    if unique_dates > 1:
        print(
            f"WARNING: Page {page} of {Path(file_name).name} has {unique_dates} different "
            "dates. Expected 1 unique date per file."
        )
        if debug:
            print(f"  Found dates: {page_df['date'].unique().tolist()}")


def check_missing_literal_values(
    full_data: pd.DataFrame,
    literal: str = "missing",
) -> pd.DataFrame:
    """Report rows containing an exact placeholder literal and return the flagged rows.

    This is mainly useful for CBORD extraction QA, where the parser may emit the exact
    string "missing" instead of a real value. The function prints a compact summary and
    returns the subset of rows containing the literal so notebooks can display or inspect
    them without duplicating the masking logic.

    Args:
        full_data: Combined extracted PDF data.
        literal: Exact string to search for. Matching is case-sensitive to preserve the
            notebook's previous behavior.

    Returns:
        DataFrame containing only rows where at least one cell equals the exact literal.
        Returns an empty DataFrame when no matches are found.
    """
    missing_mask = full_data.eq(literal)
    has_missing_literal = missing_mask.any().any()

    if not has_missing_literal:
        print(f'No cells equal to the exact string "{literal}".')
        return full_data.iloc[0:0].copy()

    missing_counts_by_col = missing_mask.sum()
    missing_counts_by_col = missing_counts_by_col[missing_counts_by_col > 0]

    print(f'Found cells equal to the exact string "{literal}".')
    print("\nCount by column:")
    print(missing_counts_by_col)

    rows_with_missing_literal = full_data[missing_mask.any(axis=1)].copy()
    print(f"\nRows containing at least one '{literal}' value: {len(rows_with_missing_literal)}")
    return rows_with_missing_literal


def _write_qa_flags_artifact(
    data_location: Path, file_name: str, page_statuses: list[dict[str, Any]]
) -> None:
    """Write the per-file QA-flags JSON artifact summarising failed pages.

    Args:
        data_location: Root data directory for the dataset.
        file_name: PDF file name the QA flags apply to.
        page_statuses: Per-page status dictionaries produced by the pipeline.
    """
    warnings = [
        {
            "page": status["page"],
            "status": status["status"],
            "error": status["error"],
            "audit_score": status.get("audit_score"),
        }
        for status in page_statuses
        if status["status"] not in COMPLETED_PAGE_STATUSES
    ]
    _write_json_artifact(
        _qa_flags_path(data_location, file_name),
        {
            "file_name": Path(file_name).name,
            "warnings": warnings,
            "page_statuses": page_statuses,
        },
    )


def run_pdf_preflight_sample(
    pdf_files: list[str],
    whisper_client: Any,
    OpenAI_client: Any,
    data_location: str | Path,
    product_name_column: str,
    desired_columns: list[str],
    numeric_columns: list[str],
    parse_extracted_pdf_prompt: str,
    debug: bool = False,
    CBORD: bool = False,
    extraction_profile: str = "auto",
    parser_mode: str = "auto",
    tuning_sample_cap: int = DEFAULT_TUNING_SAMPLE_CAP,
    tuning_random_seed: int = DEFAULT_TUNING_RANDOM_SEED,
    audit_threshold: float = DEFAULT_AUDIT_THRESHOLD,
    visual_audit_threshold: float = DEFAULT_VISUAL_AUDIT_THRESHOLD,
    gemini_client: Any = None,
    enable_gemini_fallback: bool = True,
) -> pd.DataFrame:
    """Preview a small sample of real pages before the full run."""
    data_location = Path(data_location)
    desired_columns = standardize_columns(desired_columns)
    numeric_columns = standardize_columns(numeric_columns or [])
    parse_prompt = parse_extracted_pdf_prompt or load_prompt("extract_pdf_prompt.md")
    tuning_result = (
        _resolve_auto_tuning_result(
            pdf_files,
            data_location,
            whisper_client=whisper_client,
            sample_cap=tuning_sample_cap,
            random_seed=tuning_random_seed,
        )
        if _normalize_extraction_profile(extraction_profile) == "auto"
        else {"preferred_digital_profile": None, "scores": {}, "sample_pages": []}
    )
    sample_pages = tuning_result.get("sample_pages", []) or _sample_tuning_pages(
        pdf_files,
        data_location,
        sample_cap=tuning_sample_cap,
        random_seed=tuning_random_seed,
    )

    preflight_rows: list[dict[str, Any]] = []
    for sample in sample_pages:
        context = _build_pipeline_context(
            whisper_client=whisper_client,
            OpenAI_client=OpenAI_client,
            data_location=data_location,
            file_name=sample["file_name"],
            product_name_column=product_name_column.strip().lower(),
            desired_columns=desired_columns,
            numeric_columns=numeric_columns,
            parse_extracted_pdf_prompt=parse_prompt,
            debug=debug,
            CBORD=CBORD,
            save_debug_artifacts=False,
            extraction_profile=extraction_profile,
            parser_mode=parser_mode,
            auto_repair=True,
            enable_gemini_fallback=enable_gemini_fallback,
            gemini_client=gemini_client,
            max_repair_attempts=DEFAULT_MAX_REPAIR_ATTEMPTS,
            audit_threshold=audit_threshold,
            visual_audit_threshold=visual_audit_threshold,
            persist_audit_manifest=False,
            preferred_digital_profile=tuning_result.get("preferred_digital_profile"),
        )
        result = _process_pdf_page(
            sample["page"],
            context,
            validate_existing_outputs=False,
            force_reprocess=True,
            persist_outputs=False,
        )
        preflight_rows.append(
            {
                "file_name": sample["file_name"],
                "page": sample["page"],
                "selected_profile": result.get("selected_profile", ""),
                "parser_mode": result.get("parser_mode", ""),
                "status": result["status"],
                "audit_score": result.get("audit_score"),
                "null_summary": result.get("null_summary", ""),
                "raw_extracted_text_preview": result.get("raw_extracted_text_preview", ""),
                "parsed_preview": result.get("parsed_preview", ""),
                "candidate_scores": result.get("candidate_scores", ""),
            }
        )

    return pd.DataFrame(preflight_rows)


def run_pdf_extraction_pipeline_multiple_files(
    pdf_files: list[str],
    whisper_client: Any,
    OpenAI_client: Any,
    data_location: str | Path,
    product_name_column: str,
    desired_columns: list[str],
    numeric_columns: list[str],
    parse_extracted_pdf_prompt: str,
    debug: bool = False,
    CBORD: bool = False,
    max_concurrent_files: int = DEFAULT_MAX_CONCURRENT_FILES,
    save_debug_artifacts: bool = False,
    validate_existing_outputs: bool = True,
    extraction_profile: str = "auto",
    parser_mode: str = "auto",
    auto_repair: bool = True,
    enable_gemini_fallback: bool = True,
    gemini_client: Any = None,
    max_repair_attempts: int = DEFAULT_MAX_REPAIR_ATTEMPTS,
    audit_threshold: float = DEFAULT_AUDIT_THRESHOLD,
    visual_audit_threshold: float = DEFAULT_VISUAL_AUDIT_THRESHOLD,
    persist_audit_manifest: bool = True,
    tuning_sample_cap: int = DEFAULT_TUNING_SAMPLE_CAP,
    tuning_random_seed: int = DEFAULT_TUNING_RANDOM_SEED,
) -> pd.DataFrame:
    """Process a batch of PDFs while keeping file-level concurrency and page-level traceability."""
    data_location = Path(data_location)
    desired_columns = standardize_columns(desired_columns)
    numeric_columns = standardize_columns(numeric_columns or [])
    parse_prompt = parse_extracted_pdf_prompt or load_prompt("extract_pdf_prompt.md")
    extraction_profile = _normalize_extraction_profile(extraction_profile)
    max_workers = max(1, min(max_concurrent_files, len(pdf_files) or 1))

    startup_message = (
        f"Starting PDF extraction for {len(pdf_files)} file(s) "
        f"(max_concurrent_files={max_workers}, extraction_profile={extraction_profile})."
    )
    if extraction_profile == "auto":
        startup_message += (
            " Auto profile tuning is enabled, so the first detailed output may take a moment."
        )
    print(startup_message, flush=True)

    tuning_result = {"preferred_digital_profile": None, "scores": {}, "sample_pages": []}
    if extraction_profile == "auto":
        tuning_result = _resolve_auto_tuning_result(
            pdf_files,
            data_location,
            whisper_client=whisper_client,
            sample_cap=tuning_sample_cap,
            random_seed=tuning_random_seed,
        )

    preferred_digital_profile = tuning_result.get("preferred_digital_profile")
    if preferred_digital_profile is not None and not isinstance(preferred_digital_profile, str):
        raise TypeError("PDF auto-tuning returned a non-text preferred_digital_profile value")

    file_summaries: list[dict[str, Any]] = []
    failures: list[str] = []

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(
                run_pdf_extraction_pipeline,
                whisper_client=whisper_client,
                OpenAI_client=OpenAI_client,
                file_name=file_name,
                data_location=data_location,
                product_name_column=product_name_column,
                desired_columns=desired_columns,
                numeric_columns=numeric_columns,
                parse_extracted_pdf_prompt=parse_prompt,
                debug=debug,
                CBORD=CBORD,
                save_debug_artifacts=save_debug_artifacts,
                validate_existing_outputs=validate_existing_outputs,
                extraction_profile=extraction_profile,
                parser_mode=parser_mode,
                auto_repair=auto_repair,
                enable_gemini_fallback=enable_gemini_fallback,
                gemini_client=gemini_client,
                max_repair_attempts=max_repair_attempts,
                audit_threshold=audit_threshold,
                visual_audit_threshold=visual_audit_threshold,
                persist_audit_manifest=persist_audit_manifest,
                tuning_sample_cap=tuning_sample_cap,
                tuning_random_seed=tuning_random_seed,
                preferred_digital_profile=preferred_digital_profile,
            ): file_name
            for file_name in pdf_files
        }

        for future in as_completed(futures):
            file_name = futures[future]
            try:
                summary = future.result()
                every_pdf_page_extracted_check(data_location / file_name, debug=debug)
                file_summaries.append(summary)
            except AssertionError as exception:
                failures.append(f"{Path(file_name).name}: {exception}")

    summary_df = (
        pd.DataFrame(file_summaries).sort_values("file_name").reset_index(drop=True)
        if file_summaries
        else pd.DataFrame()
    )
    _print_batch_error_summary(summary_df, failed_file_count=len(failures))
    _print_concurrency_guidance(summary_df, max_workers)
    if failures:
        print(
            (
                f"PDF extraction completed with failures for {len(file_summaries)} successful "
                f"file(s) and {len(failures)} failed file(s)."
            ),
            flush=True,
        )
        raise AssertionError(
            "PDF extraction finished but some files failed and need attention before proceeding: "
            + "; ".join(failures)
        )
    print(
        f"PDF extraction complete. Finished processing {len(file_summaries)} file(s).",
        flush=True,
    )
    return summary_df


def run_pdf_extraction_pipeline(
    whisper_client: Any,
    OpenAI_client: Any,
    pages: list[int] | None = None,
    product_name_column: str = "Product name",
    file_name: str | None = None,
    data_location: str | Path | None = None,
    desired_columns: list[str] | None = None,
    numeric_columns: list[str] | None = None,
    parse_extracted_pdf_prompt: str | None = None,
    debug: bool = False,
    CBORD: bool = False,
    save_debug_artifacts: bool = False,
    validate_existing_outputs: bool = True,
    extraction_profile: str = "auto",
    parser_mode: str = "auto",
    auto_repair: bool = True,
    enable_gemini_fallback: bool = True,
    gemini_client: Any = None,
    max_repair_attempts: int = DEFAULT_MAX_REPAIR_ATTEMPTS,
    audit_threshold: float = DEFAULT_AUDIT_THRESHOLD,
    visual_audit_threshold: float = DEFAULT_VISUAL_AUDIT_THRESHOLD,
    persist_audit_manifest: bool = True,
    tuning_sample_cap: int = DEFAULT_TUNING_SAMPLE_CAP,
    tuning_random_seed: int = DEFAULT_TUNING_RANDOM_SEED,
    preferred_digital_profile: str | None = None,
) -> dict[str, Any]:
    """Process a single PDF through extract, parse, audit, repair, and export stages."""
    if not file_name or not data_location or not desired_columns:
        raise ValueError("file_name, data_location and desired_columns are required parameters.")

    data_location = Path(data_location)
    desired_columns = standardize_columns(desired_columns)
    product_name_column = product_name_column.strip().lower()
    numeric_columns = standardize_columns(numeric_columns or [])
    parse_prompt = parse_extracted_pdf_prompt or load_prompt("extract_pdf_prompt.md")

    extracted_pages_dir = data_location / "extracted_pages"
    extracted_pages_dir.mkdir(exist_ok=True)
    extracted_files_dir = data_location / "extracted_files"
    extracted_files_dir.mkdir(exist_ok=True)

    if pages is None:
        total_pages = _count_pages(data_location / file_name)
        pages = list(range(1, total_pages + 1))
        if debug:
            print(f"Number of pages not provided, so extracting all {total_pages} pages.")

    if (
        preferred_digital_profile is None
        and _normalize_extraction_profile(extraction_profile) == "auto"
    ):
        preferred_digital_profile = _resolve_auto_tuning_result(
            [file_name],
            data_location,
            whisper_client=whisper_client,
            sample_cap=tuning_sample_cap,
            random_seed=tuning_random_seed,
        ).get("preferred_digital_profile")

    context = _build_pipeline_context(
        whisper_client=whisper_client,
        OpenAI_client=OpenAI_client,
        data_location=data_location,
        file_name=file_name,
        product_name_column=product_name_column,
        desired_columns=desired_columns,
        numeric_columns=numeric_columns,
        parse_extracted_pdf_prompt=parse_prompt,
        debug=debug,
        CBORD=CBORD,
        save_debug_artifacts=save_debug_artifacts,
        extraction_profile=extraction_profile,
        parser_mode=parser_mode,
        auto_repair=auto_repair,
        enable_gemini_fallback=enable_gemini_fallback,
        gemini_client=gemini_client,
        max_repair_attempts=max_repair_attempts,
        audit_threshold=audit_threshold,
        visual_audit_threshold=visual_audit_threshold,
        persist_audit_manifest=persist_audit_manifest,
        preferred_digital_profile=preferred_digital_profile,
    )

    page_statuses = [
        _process_pdf_page(
            page,
            context,
            validate_existing_outputs=validate_existing_outputs,
        )
        for page in pages
    ]

    # The explicit second sweep is intentionally separate from the first-page repair ladder.
    # The first pass can still be influenced by multi-file concurrency pressure or upstream
    # transients; this follow-up pass gives failed or below-threshold pages one quieter retry.
    repair_sweep_pages = [
        status["page"]
        for status in page_statuses
        if status["status"] == AUDIT_FAILED_STATUS
        or (status["status"] not in COMPLETED_PAGE_STATUSES and status.get("retryable", False))
    ]
    if repair_sweep_pages:
        page_statuses = [
            (
                _process_pdf_page(
                    status["page"],
                    context,
                    validate_existing_outputs=False,
                    force_reprocess=True,
                )
                if status["page"] in repair_sweep_pages
                else status
            )
            for status in page_statuses
        ]

    _write_qa_flags_artifact(data_location, file_name, page_statuses)

    file_summary = _summarize_page_statuses(file_name=file_name, page_statuses=page_statuses)
    _print_file_summary(file_summary)

    if file_summary["failed_pages"]:
        raise AssertionError(
            f"PDF extraction finished for '{Path(file_name).name}' but some pages failed and "
            "need attention before proceeding: " + "; ".join(file_summary["failed_pages"])
        )

    combined_output_path = _build_combined_file_output(
        data_location=data_location,
        file_name=file_name,
        intended_columns=[*desired_columns, "page", "original_file"],
    )
    file_summary["combined_output_path"] = str(combined_output_path) if combined_output_path else ""
    if debug and combined_output_path is not None:
        print(f"Saved combined file data to: {combined_output_path}")
    return file_summary


def combine_extracted_pdf_pages(
    data_location: str | Path,
    intended_columns: list[str],
    file_name: str | None = None,
) -> pd.DataFrame:
    """
    Combines all CSV files from the 'extracted_pages' subdirectory into a single pandas DataFrame.

    This function is used in the PDF extraction workflow to aggregate data from multiple
    per-page CSV files.

    For each CSV file found in 'extracted_pages':
        1. Reads the CSV into a pandas DataFrame.
        2. Standardizes column names: strips leading/trailing whitespace and converts to
           lowercase.
        3. Asserts that the loaded DataFrame is not empty.
        4. Checks if the DataFrame's columns match `intended_columns` (case-insensitive).
           - If columns are missing from `intended_columns`, a warning is printed.
           - If there are extra columns not in `intended_columns`, they are dropped.
           The DataFrame is then subset to only include columns from `intended_columns`.
        5. Appends the processed DataFrame to a list for later concatenation.

    Args:
        data_location: The directory path (string or Path object) containing the CSV files
            to be combined.
        intended_columns: A list of column names (case-insensitive) that are expected to be
            present in each CSV file. The final combined DataFrame will only contain these
            columns.

    Returns:
        pandas.DataFrame: A DataFrame containing the combined and cleaned data from all valid
            CSV files found in 'extracted_pages'. Returns an empty DataFrame if no CSV files
            are found or if no data is successfully processed from the found CSVs.

    Raises:
        AssertionError: If a DataFrame loaded from a CSV file is empty.
    """

    data_location = Path(data_location)
    extracted_files_dir = data_location / "extracted_files"
    extracted_pages_dir = data_location / "extracted_pages"
    if file_name is not None:
        combined_files = []
        csv_files = sorted(extracted_pages_dir.glob(f"{Path(file_name).stem}_page_*_extracted.csv"))
    else:
        combined_files = sorted(extracted_files_dir.glob("*_combined_extracted.csv"))
        csv_files = sorted(extracted_pages_dir.glob("*.csv"))

    intended_columns_lower = standardize_columns(intended_columns)
    dfs = []
    source_files = combined_files if combined_files else csv_files
    for file in source_files:
        if not file.exists():
            continue
        df = pd.read_csv(file)
        df.columns = standardize_columns([str(column) for column in df.columns])
        assert not df.empty, f"DataFrame loaded from {file} is empty."
        if set(df.columns) != set(intended_columns_lower):
            missing_cols = set(intended_columns_lower) - set(df.columns)
            extra_cols = set(df.columns) - set(intended_columns_lower)
            if missing_cols or extra_cols:
                print(
                    f"Warning: {os.path.basename(str(file))} has missing columns "
                    f"{list(missing_cols)} and extra columns {list(extra_cols)}"
                )
            # Keep columns that are in intended_columns, preserving order
            df = df[[col for col in df.columns if col in intended_columns_lower]]
        dfs.append(df)

    combined_df = pd.concat(dfs, ignore_index=True) if dfs else pd.DataFrame()

    return combined_df


def markdown_to_df(
    markdown: str,
    numeric_columns: list[str] | None = None,
    product_name_column: str = "Product name",
    desired_columns: list[str] | None = None,
    debug: bool = True,
) -> pd.DataFrame:
    """
    Converts a Markdown string, expected to represent a table, into a cleaned pandas DataFrame.

    The function performs the following operations:
    1.  Reads the Markdown table: Uses `pd.read_csv` with '|' as a separator.
        Column names are stripped of leading/trailing whitespace.
    2.  Product name column handling (if `product_name_column` exists):
        - Asserts that the `product_name_column` does not have more than 10% null values.
        - Converts the `product_name_column` to string type.
        - Removes rows where `product_name_column` contains '---' (often a Markdown separator line).
    3.  Drops columns that consist entirely of null values.
    4.  Desired columns validation (if `desired_columns` are provided):
        - Asserts that all `desired_columns` are present in the DataFrame after the previous steps.
        - Subsets the DataFrame to only include `desired_columns`.
    5.  Strips leading/trailing whitespace from all string cell values in the DataFrame.
    6.  Numeric column conversion (if `numeric_columns` are provided):
        - For each column name in `numeric_columns`, the function attempts to convert
          that column in the DataFrame to a numeric type. It specifically handles
          string columns by first removing commas (e.g., "1,000" -> "1000") before
          conversion. Any values that cannot be converted will become NaN. A debug
          message is printed for each column that is converted.

    Args:
        markdown (str): A string containing a Markdown-formatted table.
        numeric_columns (Union[List[str], None], optional): A list of column names
            that should be converted to numeric types. Defaults to None.
        product_name_column (str, optional): The name of the column expected to
            contain product names. This column undergoes specific cleaning and validation.
            Defaults to "Product name".
        desired_columns (Union[List[str], None], optional): A list of column names
            that are expected to be in the final DataFrame. If provided, the DataFrame
            will be filtered to include only these columns. Defaults to None.
        debug (bool, optional): If True, prints messages during processing, such as
            columns being dropped or converted. Defaults to True.

    Returns:
        pd.DataFrame: A pandas DataFrame derived from the Markdown table, having undergone
                      the cleaning and validation steps described above.

    Raises:
        AssertionError:
            - If `product_name_column` (when present) has over 10% null values.
            - If any `desired_columns` (when provided) are not found in the DataFrame
              after initial cleaning.
    """

    pulled_data = pd.read_csv(
        io.StringIO(markdown),
        sep="|",
        skipinitialspace=True,
    )
    pulled_data.columns = pulled_data.columns.str.strip().str.lower()

    if pulled_data.empty:
        raise AssertionError("Parsed markdown table is empty before cleaning.")

    return _clean_parsed_page_df(
        pulled_data,
        desired_columns=desired_columns,
        numeric_columns=numeric_columns,
        product_name_column=product_name_column,
        debug=debug,
        enforce_product_null_threshold=True,
        drop_all_null_columns=True,
        empty_after_cleaning_message="Parsed markdown table is empty after cleaning.",
    )


def LLM_process_extracted_pdf_text(
    OpenAI_client: Any,
    extracted_text: str | LLMWhispererClientException,
    prompt: str | None = None,
) -> str:
    """
    Processes raw text, typically from a single PDF page, using the shared OpenAI
    PDF parser model to convert it into a Markdown table.

    This function is intended for processing text extracted from individual PDF pages.
    It handles cases where `extracted_text` might be an `LLMWhispererClientException`
    by printing the exception and returning an empty string. It also returns an
    empty string if the input `extracted_text` is empty.

    If no custom `prompt` is provided, a default system prompt is used. This default
    prompt instructs the LLM to:
    - Identify table data within the single page's text.
    - Handle multi-line rows and messy formatting.
    - Output a clean Markdown table.
    - If no table is found, state "No table found on this page."
    - Output only the Markdown table or the "No table found" message, without
      additional explanations or Markdown code blocks.

    Args:
        OpenAI_client: An initialized OpenAI API client instance.
        extracted_text: The raw text string from a single PDF page. Can also be an
                        `LLMWhispererClientException` if the prior extraction failed.
        prompt: Optional. A custom system prompt for the LLM. If None (default),
                the function uses a built-in default prompt suitable for single-page
                table extraction.

    Returns:
        str: A string containing the LLM-generated Markdown table or the message
             "No table found on this page."
             Returns an empty string if:
             - `extracted_text` is an `LLMWhispererClientException`.
             - `extracted_text` is an empty string.
             - The LLM response content is empty.
             - An exception occurs during the LLM API call.
    """

    if prompt is None:
        prompt = load_prompt("extract_pdf_prompt.md")
    result = _call_openai_prompt_with_metadata(
        OpenAI_client=OpenAI_client,
        prompt=prompt,
        user_content=extracted_text,
    )
    if result["error"]:
        print(result["error"])
    return result["processed_text"]


# ----------------------------------------------------------------------
# Validate extractions
# ----------------------------------------------------------------------


def plot_rows_by_page_for_each_pdf(
    page_file_counts: pd.DataFrame,
    value_column: str,
    title: str,
    y_label: str,
    add_zero_line: bool = False,
    subtitle: str | None = None,
) -> None:
    """Plot one line per PDF across page numbers for the requested metric."""
    title_fontsize = 16.25
    subtitle_fontsize = 12.5

    plot_data = page_file_counts.sort_values(["original_file", "page"])
    unique_files = plot_data["original_file"].drop_duplicates().tolist()
    color_map = plt.get_cmap("tab20", max(len(unique_files), 1))

    fig, ax = plt.subplots(figsize=(14, 8))

    for idx, original_file in enumerate(unique_files):
        file_data = plot_data[plot_data["original_file"] == original_file]
        ax.plot(
            file_data["page"],
            file_data[value_column],
            marker="o",
            linewidth=1.8,
            markersize=4,
            alpha=0.85,
            label=original_file,
            color=color_map(idx),
        )

    if add_zero_line:
        ax.axhline(0, color="black", linestyle="--", linewidth=1, alpha=0.5)
    else:
        ax.set_ylim(bottom=0)

    ax.yaxis.set_major_locator(MaxNLocator(integer=True))

    ax.set_xlabel("Page Number", fontsize=12)
    ax.set_ylabel(y_label, fontsize=12)
    if subtitle:
        fig.suptitle(title, fontsize=title_fontsize, y=0.955)
        ax.set_title(subtitle, fontsize=subtitle_fontsize, style="italic", pad=2)
    else:
        ax.set_title(title, fontsize=title_fontsize)
    ax.grid(True, alpha=0.3)
    if len(unique_files) <= 10:
        ax.legend(title="PDF", bbox_to_anchor=(1.02, 1), loc="upper left", fontsize=8)
    if subtitle:
        fig.tight_layout(rect=(0, 0, 1, 0.95))
    else:
        fig.tight_layout()
    plt.show()


def exclude_last_page_per_pdf(page_file_counts: pd.DataFrame) -> pd.DataFrame:
    """Remove the highest page number for each PDF before plotting page-level trends."""
    max_page_per_file = page_file_counts.groupby("original_file")["page"].transform("max")
    return page_file_counts.loc[page_file_counts["page"] < max_page_per_file].copy()


def find_most_deviating_file_page_combos(
    page_file_counts: pd.DataFrame,
    n: int = 10,
    exclude_last_page: bool = True,
    include_zero_deviation: bool = False,
) -> pd.DataFrame:
    """Return the file-page combinations with the largest row-count deviations.

    This helper is intended to pair with ``plot_rows_by_page_for_each_pdf`` when
    plotting ``deviation_from_pdf_median``. It ranks the individual
    ``original_file`` x ``page`` combinations by the absolute distance from that
    PDF's median row count, making it easy to see which exact pages produced the
    most unusual dips or spikes.

    Args:
        page_file_counts: DataFrame with at least ``original_file``, ``page``, and
            ``row_count``. If ``median_row_count`` or ``deviation_from_pdf_median``
            are missing, they are calculated inside the function.
        n: Number of most deviant file-page combinations to return.
        exclude_last_page: Whether to exclude the final page of each PDF before
            ranking deviations. Defaults to True because last pages are often
            naturally shorter.
        include_zero_deviation: Whether to keep rows whose deviation is exactly
            zero. Defaults to False so the output focuses on actual spikes or dips.

    Returns:
        DataFrame sorted by largest absolute deviation first.
    """
    required_columns = {"original_file", "page", "row_count"}
    missing_columns = required_columns.difference(page_file_counts.columns)
    if missing_columns:
        missing_list = ", ".join(sorted(missing_columns))
        raise ValueError(f"page_file_counts is missing required columns: {missing_list}")

    ranked = page_file_counts.copy()

    if "median_row_count" not in ranked.columns:
        ranked["median_row_count"] = ranked.groupby("original_file")["row_count"].transform(
            "median"
        )

    if "deviation_from_pdf_median" not in ranked.columns:
        ranked["deviation_from_pdf_median"] = ranked["row_count"] - ranked["median_row_count"]

    if exclude_last_page:
        ranked = exclude_last_page_per_pdf(ranked)

    ranked["absolute_deviation_from_pdf_median"] = ranked["deviation_from_pdf_median"].abs()

    if not include_zero_deviation:
        ranked = ranked.loc[ranked["absolute_deviation_from_pdf_median"] > 0].copy()

    ranked = ranked.sort_values(
        [
            "absolute_deviation_from_pdf_median",
            "deviation_from_pdf_median",
            "original_file",
            "page",
        ],
        ascending=[False, False, True, True],
    ).reset_index(drop=True)

    return ranked.head(n)


def plot_bar_by_pdf(
    file_summary: pd.DataFrame,
    value_column: str,
    title: str,
    y_label: str,
    color: str,
) -> None:
    """Plot one bar per PDF for a file-level summary metric."""
    plot_data = file_summary.sort_values(value_column, ascending=False)
    bar_positions = list(range(len(plot_data)))

    fig, ax = plt.subplots(figsize=(12, max(6, len(plot_data) * 0.3)))
    ax.barh(bar_positions, plot_data[value_column], color=color, alpha=0.85, height=0.9)
    ax.set_yticks(bar_positions, labels=plot_data["original_file"])
    ax.set_ylim(len(plot_data) - 0.5, -0.5)
    ax.set_xlabel(y_label, fontsize=12)
    ax.set_ylabel("")
    ax.set_title(title, fontsize=13)
    ax.grid(True, axis="x", alpha=0.3)
    ax.tick_params(axis="y", labelsize=9)
    ax.set_xlim(left=0)
    fig.tight_layout()
    plt.show()


def plot_total_rows_by_page_across_pdfs(page_counts: pd.Series) -> None:
    """Plot total extracted rows at each page number across all PDFs."""
    plot_data = page_counts.rename_axis("page").reset_index(name="total_rows").sort_values("page")

    fig, ax = plt.subplots(figsize=(12, 6))
    ax.plot(
        plot_data["page"],
        plot_data["total_rows"],
        marker="o",
        linewidth=2,
        markersize=4,
        color=GBD_colors[4],
    )
    ax.set_xlabel("Page Number", fontsize=12)
    ax.set_ylabel("Total Rows Across All PDFs", fontsize=12)
    ax.set_title("Total Row Count by Page Number Across All PDFs", fontsize=13)
    ax.grid(True, alpha=0.3)
    ax.set_ylim(bottom=0)
    fig.tight_layout()
    plt.show()


def summarize_pdf_validation_data(
    combined_df: pd.DataFrame,
) -> dict[str, pd.Series | pd.DataFrame]:
    """
    Build row-count summaries used for PDF extraction QA plots.

    This consolidates the notebook-level aggregation step into a reusable package
    helper so notebooks can stay focused on orchestration and plotting.

    Args:
        combined_df: The pandas DataFrame (typically from `combine_extracted_pdf_pages`)
            to summarize.

    Returns:
        Dictionary containing the Series/DataFrames needed for page-level and
        file-level QA plots.
    """
    page_file_counts = (
        combined_df.groupby(["original_file", "page"]).size().to_frame("row_count").reset_index()
    )
    file_counts = combined_df["original_file"].value_counts()
    page_counts = combined_df["page"].value_counts()

    page_file_counts["median_row_count"] = page_file_counts.groupby("original_file")[
        "row_count"
    ].transform("median")
    page_file_counts["deviation_from_pdf_median"] = (
        page_file_counts["row_count"] - page_file_counts["median_row_count"]
    )
    plot_page_file_counts = exclude_last_page_per_pdf(page_file_counts)
    file_summary = page_file_counts.groupby("original_file", as_index=False).agg(
        total_rows=("row_count", "sum"),
        total_pages=("page", "max"),
    )

    return {
        "file_counts": file_counts,
        "page_counts": page_counts,
        "page_file_counts": page_file_counts,
        "plot_page_file_counts": plot_page_file_counts,
        "file_summary": file_summary,
    }


def sample_files_and_rows(
    df: pd.DataFrame, num_files: int = 5, rows_per_file: int = 5
) -> pd.DataFrame:
    """
    Samples a subset of data from a DataFrame for manual validation of PDF extractions.

    This function is designed to help users quickly check the quality of PDF data
    extraction by providing a manageable sample. It works by:
    1. Randomly selecting a specified number of unique 'original_file' values from the input
       DataFrame.
    2. For each selected file, it randomly chooses a starting row index.
    3. It then extracts a specified number of consecutive rows starting from that index.
       If a file has fewer rows than `rows_per_file`, all its rows are taken.

    The use of `random.sample` for file selection and `random.randint` for start index
    selection means the sampling is random. For reproducible samples, ensure the global
    random seed is set before calling this function.

    Args:
        df (pd.DataFrame): The input DataFrame containing extracted data. Must include
                           an 'original_file' column to identify source files.
        num_files (int, optional): The number of unique files to sample from.
                                   Defaults to 5. If `df` contains fewer unique
                                   files, all unique files will be sampled.
        rows_per_file (int, optional): The number of consecutive rows to sample
                                       from each selected file. Defaults to 5.

    Returns:
        pd.DataFrame: A new DataFrame consisting of the sampled rows from the
                      selected files. A message is printed indicating the number
                      of rows and files sampled.
    """

    # Random sample of filenames
    unique_files = df["original_file"].unique().tolist()
    selected_files = random.sample(unique_files, min(num_files, len(unique_files)))  # nosec B311

    # Create an empty list to store sampled rows
    sampled_rows = []

    # For each file, sample consecutive rows
    for file in selected_files:
        file_df = df[df["original_file"] == file].reset_index(drop=True)

        # If file has fewer rows than requested, take all rows
        if len(file_df) <= rows_per_file:
            sampled_rows.append(file_df)
        else:
            # Select a random starting point to ensure we can get consecutive rows
            max_start_idx = len(file_df) - rows_per_file
            start_idx = random.randint(0, max_start_idx)  # nosec B311 so bandit doesn't complain

            # Get consecutive rows from the starting point
            consecutive_rows = file_df.iloc[start_idx : start_idx + rows_per_file]
            sampled_rows.append(consecutive_rows)

    # Combine all sampled rows into one dataframe
    result = pd.concat(sampled_rows, ignore_index=True)

    print(f"Sampled {len(result)} rows from {len(selected_files)} unique files")

    return result


def check_duplicates(combined_df: pd.DataFrame) -> bool:
    """
    Checks for duplicate rows in a DataFrame.

    Args:
        combined_df: The pandas DataFrame to check for duplicates.

    Returns:
        True if no duplicate rows are found (i.e., the assertion passes).

    Raises:
        AssertionError: If duplicate rows are found, an error is raised
                        with the count of duplicate rows.
    """

    duplicate_rows = combined_df.duplicated()
    num_duplicates = duplicate_rows.sum()
    assert num_duplicates == 0, f"Found {num_duplicates} duplicate rows in combined_df"

    return True


def every_pdf_page_extracted_check(pdf_full_path: str | Path, debug: bool = True) -> bool:
    """
    Checks if all pages of a PDF have corresponding extracted CSV files.

    It determines the number of pages in the PDF and looks for CSV files named
    `{pdf_name_without_extension}_page_{page_number}_extracted.csv` in the same directory
    as the PDF file.

    Args:
        pdf_full_path: The full path to the PDF file.
        debug: If True, prints detailed messages about missing pages or success.
                 Defaults to True.

    Returns:
        True if a CSV file exists for every page of the PDF and the assertion passes.

    Raises:
        FileNotFoundError: If the specified PDF file does not exist.
        AssertionError: If any page-specific CSV files are missing.
    """

    pdf_path_obj = Path(pdf_full_path)
    data_location = pdf_path_obj.parent
    extracted_pages_dir = data_location / "extracted_pages"
    pdf_file_name = pdf_path_obj.name

    if not pdf_path_obj.exists():
        raise FileNotFoundError(f"PDF file not found: {pdf_path_obj}")

    total_pages = len(PdfReader(pdf_path_obj).pages)

    if total_pages == 0:
        print(f"Warning: PDF file {pdf_file_name} has 0 pages.")
        return True  # Or False, depending on desired behavior for 0-page PDFs

    pdf_file_stem = pdf_path_obj.stem
    missing_pages = []

    for page_number in range(1, total_pages + 1):
        expected_csv_name = f"{pdf_file_stem}_page_{page_number}_extracted.csv"
        expected_csv_path = extracted_pages_dir / expected_csv_name
        metadata_path = _page_metadata_path(data_location, pdf_file_name, page_number)
        metadata = _read_json_artifact(metadata_path)
        metadata_status = metadata.get("status")
        if expected_csv_path.exists():
            continue
        if metadata_status in {NO_TABLE_STATUS, "skipped_existing"}:
            continue
        missing_pages.append(expected_csv_name)

    assert not missing_pages, (
        f"Missing extracted outputs for the following pages of '{pdf_file_name}': {missing_pages}"
    )
    if debug:
        print(
            f"All {total_pages} pages of '{pdf_file_name}' have a corresponding extracted "
            "output or no-table sidecar."
        )
    return True


def check_high_duplicate_pages(df: pd.DataFrame, product_name_col: str) -> pd.DataFrame:
    """
    Identifies and reports pages within PDF files that have strong product repetition.

    For each page of each file it calculates:
    - The percentage of duplicate rows (identical rows).
    - The count of product names that appear 3 or more times.

    Pages are returned when they look suspicious by either signal:
    - duplicate rows make up at least half of the page, or
    - more than one product name appears 3 or more times.

    The output includes both signals so analysts can tell whether the page looks
    duplicated because of exact repeated rows, repeated product names, or both.

    Args:
        df (pd.DataFrame): A DataFrame containing extracted PDF data, requiring
                           'original_file' and 'page' columns. It should also
                           contain the data rows to be checked for duplicates.
                           Assumes that each row in `df` represents an extracted line or item.
        product_name_col (str): The name of the column containing product names to check
                               for repetition patterns.

    Returns:
        pd.DataFrame: A DataFrame with columns 'original_file', 'page', 'duplicate_percentage',
                     'repeated_products_count', and 'warning' containing information about pages
                     with suspicious duplication patterns. Returns an empty DataFrame with
                     those columns if no such pages are found.
    """
    output_columns = [
        "original_file",
        "page",
        "duplicate_percentage",
        "repeated_products_count",
        "warning",
    ]

    # Get unique combinations of 'original_file' and 'page'
    unique_combinations = df[["original_file", "page"]].drop_duplicates()

    print("Checking for pages with repeated product patterns...")

    results = []

    # Iterate over each unique combination
    for _, row in unique_combinations.iterrows():
        file = row["original_file"]
        page_num = row["page"]

        # Filter the DataFrame for the current file and page
        subset_df = df[(df["original_file"] == file) & (df["page"] == page_num)]

        if len(subset_df) == 0:
            continue

        total_rows = len(subset_df)

        # Calculate actual duplicate rows (identical rows)
        duplicated_mask = subset_df.duplicated(keep=False)
        num_duplicate_rows = duplicated_mask.sum()
        duplicate_percentage = (num_duplicate_rows / total_rows) * 100 if total_rows > 0 else 0

        # Check for product name repetition patterns
        product_counts = subset_df[product_name_col].value_counts()
        repeated_products = product_counts[product_counts >= 3]
        repeated_products_count = len(repeated_products)

        warning_parts = []
        if duplicate_percentage >= 50:
            warning_parts.append(f"{round(duplicate_percentage, 2)}% duplicate rows")
        if repeated_products_count >= 2:
            warning_parts.append(f"{repeated_products_count} product names repeated 3+ times")

        if duplicate_percentage >= 50 or repeated_products_count > 1:
            results.append(
                {
                    "original_file": file,
                    "page": page_num,
                    "duplicate_percentage": round(duplicate_percentage, 2),
                    "repeated_products_count": repeated_products_count,
                    "warning": "; ".join(warning_parts),
                }
            )

    if not results:
        print("No pages with suspicious duplication patterns found.")
        return pd.DataFrame(columns=output_columns)

    results_df = (
        pd.DataFrame(results)
        .sort_values(
            by=["duplicate_percentage", "repeated_products_count", "original_file", "page"],
            ascending=[False, False, True, True],
        )
        .reset_index(drop=True)
    )
    print(f"Found {len(results_df)} pages with potential issues.")
    return results_df


def check_extraction_by_page(data: pd.DataFrame, n: int = 10) -> pd.DataFrame:
    """
    Identifies pages with potentially abnormal mean row counts across all extracted PDF data.

    This function is used to spot pages that might have extraction issues, such as
    extracting too few rows (potential missed data) or too many rows (potential
    duplicates or errors). It calculates the mean number of rows for each page number
    across all processed files.

    It then returns a DataFrame showing:
    - The `n` pages with the highest mean row counts.
    - The `n` pages with the lowest mean row counts.
    If the total number of unique pages is less than `2 * n`, it returns all unique
    pages sorted by their mean row counts.

    Additionally, creates a line plot showing the mean row count by page number to
    visualize extraction patterns across pages.

    This allows for a quick comparison of mean row counts per page number to identify
    pages that are outliers.

    Args:
        data (pd.DataFrame): A DataFrame containing extracted PDF data, requiring
                             a 'page' column (numeric, representing page numbers)
                             and 'original_file' column (to identify different files).
                             Each row typically represents an extracted item/line.
        n (int, optional): The number of pages to return from both the top (highest
                           mean counts) and bottom (lowest mean counts) of the sorted page counts.
                           Defaults to 10.

    Returns:
        pd.DataFrame: A DataFrame with columns 'page' and 'mean_count', showing the
                      pages with the `n` highest and `n` lowest mean row counts.
                      If fewer than `2*n` unique pages exist, all are returned,
                      sorted by mean_count.
    """
    # Count rows per page per file, then calculate mean across files
    page_file_counts = (
        data.groupby(["original_file", "page"]).size().to_frame("count").reset_index()
    )
    mean_counts = page_file_counts.groupby("page")["count"].mean().reset_index(name="mean_count")

    # Create line plot showing mean count by page number
    plot_data = mean_counts.sort_values("page")
    plt.figure(figsize=(12, 6))
    plt.plot(plot_data["page"], plot_data["mean_count"], marker="o", linewidth=2, markersize=4)
    plt.xlabel("Page Number", fontsize=12)
    plt.ylabel("Mean Row Count", fontsize=12)
    plt.title("Mean Row Count by Page Number", fontsize=13)
    plt.grid(True, alpha=0.3)
    plt.ylim(bottom=0)
    plt.tight_layout()
    plt.show()

    mean_counts = mean_counts.sort_values("mean_count", ascending=False)
    return get_head_and_tail(mean_counts, n)


def plot_rowcount_against_pagenum(data: pd.DataFrame) -> None:
    """Plot total extracted row count against max page number for each file.

    This is a visual QA check for file-level extraction problems. Each point is one
    PDF. Files that sit far away from the general trend may have missing pages,
    duplicate extraction, or some other parsing issue.

    The chart also includes a reference line of the form ``y = m x``, where ``m``
    is the typical rows-per-page ratio across files. Points near that line show
    the expected pattern where files with more pages also have proportionally more
    extracted rows.

    Args:
        data: DataFrame containing at least ``original_file`` and ``page`` columns.

    Returns:
        None. The function only renders a plot.
    """
    counts = data.value_counts("original_file").reset_index()
    max_page_per_file = data.groupby("original_file")["page"].max().reset_index(name="max_page")
    counts = counts.merge(max_page_per_file, on="original_file", how="left")
    counts = counts.loc[counts["max_page"] > 0].copy()

    if counts.empty:
        raise ValueError("No files with positive page numbers were found in the input data.")

    rows_per_page = counts["count"] / counts["max_page"]
    slope = rows_per_page.median()

    fig, ax = plt.subplots(figsize=(10, 8))
    ax.scatter(counts["max_page"], counts["count"], alpha=0.6, s=100)

    x_upper_limit = counts["max_page"].max() * 1.05 if counts["max_page"].max() > 0 else 1
    reference_y_upper = slope * x_upper_limit
    y_upper_limit = max(counts["count"].max(), reference_y_upper) * 1.05
    ax.plot(
        [0, x_upper_limit],
        [0, reference_y_upper],
        linestyle="--",
        linewidth=1.5,
        color="black",
        alpha=0.6,
    )
    ax.set_xlim(0, x_upper_limit)
    ax.set_ylim(0, y_upper_limit)

    for _idx, row in counts.iterrows():
        ax.annotate(
            row["original_file"],
            (row["max_page"], row["count"]),
            fontsize=8,
            alpha=0.7,
            xytext=(5, 5),
            textcoords="offset points",
        )

    ax.set_xlabel("Max Page Number", fontsize=12)
    ax.set_ylabel("Row Count", fontsize=12)
    ax.set_title(
        (
            "Row Count vs Max Page Number by File\n"
            "(Files deviating from trend may indicate failed extraction)"
        ),
        fontsize=13,
    )
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    plt.show()


# ----------------------------------------------------------------------
# Validate PDF extractions: Detect misspellings
# ----------------------------------------------------------------------


def find_possible_misspellings(
    df: pd.DataFrame,
    threshold: int = DEFAULT_MISSPELLING_SIMILARITY_THRESHOLD,
    product_name_col: str = "product",
) -> pd.DataFrame:
    """
    Find pairs of product names within a DataFrame that might be misspellings
    of each other, based on a similarity ratio threshold.

    It calculates the similarity (using `thefuzz.fuzz.ratio`) between all unique
    pairs of product names in the 'product' column. Pairs with a similarity
    score greater than or equal to the specified `threshold` are considered
    potential misspellings. While the 'date' column is a required input,
    it is not used in the similarity calculation.

    Args:
        df (pd.DataFrame): Input DataFrame. Must contain 'product' and 'date' columns.
        threshold (int, optional): Similarity ratio threshold (0-100) for considering
                                   a pair as a potential misspelling.
                                   Defaults to `DEFAULT_MISSPELLING_SIMILARITY_THRESHOLD` (85).

    Returns:
        pd.DataFrame: A DataFrame containing potential misspelling pairs, with columns:
                      'Product 1', 'Product 2', and 'Similarity Score (%)'.
                      The DataFrame is sorted by 'Similarity Score (%)' in descending order.
                      Returns an empty DataFrame with these columns if no pairs meet the
                      threshold.

    Raises:
        TypeError: If `df` is not a pandas DataFrame.
        ValueError: If `df` does not have 'product' or 'date' columns.
    """
    # --- Input Validation ---
    if not isinstance(df, pd.DataFrame):
        raise TypeError("Input 'df' must be a pandas DataFrame.")
    if product_name_col not in df.columns:
        raise ValueError(f"The DataFrame must have a '{product_name_col}' column.")
    if "date" not in df.columns:
        raise ValueError("The DataFrame must have a 'date' column.")

    # The following block is a remnant of a previous implementation where date
    # proximity was considered. The logic is preserved, but the 'date' column
    # is not actually used in the current version of the function.
    df_copy = df.copy()
    try:
        # Ensure 'date' column is in a comparable format (e.g., pd.Timestamp for consistency)
        # This step might be adjusted based on how dates are actually used for comparison
        if not pd.api.types.is_datetime64_any_dtype(df_copy["date"]):
            df_copy["date"] = pd.to_datetime(df_copy["date"])
    except Exception as e:
        print(f"Warning: Could not convert 'date' column to datetime: {e}")
        # Decide how to proceed if date conversion fails, e.g., skip date-based logic or
        # return empty
        # For now, we'll proceed, but similarity won't consider date proximity effectively.

    # --- Core Logic ---
    product_names = df_copy[product_name_col].astype(str).unique()
    similar_products_list = []  # Store results as a list first

    for i in range(len(product_names)):
        for j in range(i + 1, len(product_names)):
            product1_name = str(product_names[i])  # Ensure string type
            product2_name = str(product_names[j])  # Ensure string type
            similarity = fuzz.ratio(product1_name, product2_name)
            if similarity >= threshold:
                # The date comparison logic here was problematic and its utility unclear
                # without further context on how date proximity should influence misspelling
                # detection.
                # If date comparison is needed, it should be re-evaluated.
                # For now, focusing on name similarity.
                similar_products_list.append(
                    {
                        "Product 1": product1_name,
                        "Product 2": product2_name,
                        "Similarity Score (%)": similarity,
                    }
                )

    # --- Format Output ---
    if similar_products_list:
        # Create DataFrame from the list of dictionaries
        df_errors = pd.DataFrame(similar_products_list)
        # Sort by score (descending) and reset index
        df_errors = df_errors.sort_values(by="Similarity Score (%)", ascending=False).reset_index(
            drop=True
        )
        return df_errors
    else:
        # Return an empty DataFrame with the correct columns if no pairs found
        return pd.DataFrame(columns=["Product 1", "Product 2", "Similarity Score (%)"])


def identify_unique_product_names(
    df: pd.DataFrame, product_name_col: str = "product"
) -> pd.DataFrame:
    """
    Identify and return products that appear only once in the 'product' column,
    as these might indicate misspellings or unique entries.

    Args:
        df (pd.DataFrame): The input DataFrame. Must contain a 'product' column.

    Returns:
        pd.DataFrame: A DataFrame containing only the rows where the product name
                      appears exactly once in the entire 'product' column.

    Raises:
        AssertionError: If the 'product' column is not found in the DataFrame.
    """

    assert product_name_col in df.columns, f"The DataFrame must have a '{product_name_col}' column."

    unique_products: pd.Series = df[product_name_col].value_counts()
    single_occurrence_products = unique_products[unique_products == 1].index
    single_occurrence_df = df[df[product_name_col].isin(single_occurrence_products)]
    return single_occurrence_df
