"""
LLM helpers that turn raw source material into usable text: PDFs, spreadsheet exports, and the
free-text unit and weight strings clients put in a single column.

These are the only LLM calls that go through LLM Whisperer, and the only ones with a retry layer.
Transport lives in `llm`, prompt text in `llm_prompts`.
"""

import os
import random
import time
from pathlib import Path
from typing import Any

from gbd_foodservice_insights.llm import call_gemini_api, get_gemini_model
from openai import OpenAI
from requests.exceptions import ConnectionError, ReadTimeout, Timeout
from unstract.llmwhisperer.client_v2 import LLMWhispererClientException

from gbd_foodservice_insights_lab.llm_prompts import load_prompt

RETRYABLE_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}

DEFAULT_WEIGHT_EXTRACTION_MODEL = get_gemini_model("clean_product_weights.weight_extraction")
DEFAULT_PDF_MODEL = "gpt-4o"


def _looks_retryable_message(message: str) -> bool:
    """Heuristic fallback for API errors that do not expose a status code."""
    lowered = message.lower()
    retryable_fragments = (
        "timeout",
        "timed out",
        "temporarily unavailable",
        "rate limit",
        "too many requests",
        "connection reset",
        "connection aborted",
        "bad gateway",
        "service unavailable",
        "gateway timeout",
        "internal server error",
    )
    return any(fragment in lowered for fragment in retryable_fragments)


def _is_retryable_exception(exception: Exception) -> bool:
    """Best-effort detection of temporary network or upstream service failures."""
    if isinstance(exception, (ReadTimeout, ConnectionError, Timeout)):
        return True
    status_code = getattr(exception, "status_code", None)
    if status_code in RETRYABLE_STATUS_CODES:
        return True
    return _looks_retryable_message(str(exception))


def _retry_wait_seconds(attempt: int) -> float:
    """Back off between retries to avoid hammering upstream APIs."""
    base_wait = 2 * attempt
    jitter = random.uniform(0.0, 0.5)  # nosec B311
    return base_wait + jitter


def call_openai_prompt_with_metadata(
    openai_client: Any,
    prompt: str,
    user_content: str | LLMWhispererClientException,
    *,
    model: str = DEFAULT_PDF_MODEL,
    max_retries: int = 3,
    temperature: float = 0.0,
) -> dict[str, Any]:
    """Call an OpenAI chat model and return text plus retry metadata."""
    if isinstance(user_content, LLMWhispererClientException):
        return {
            "processed_text": "",
            "error": f"LLMWhispererClientException occurred: {user_content}",
            "retryable": False,
            "attempts": 0,
            "model": model,
        }
    if not user_content:
        return {
            "processed_text": "",
            "error": "No extracted text provided to the parser.",
            "retryable": False,
            "attempts": 0,
            "model": model,
        }

    last_exception: Exception | None = None
    for attempt in range(1, max_retries + 1):
        try:
            response = openai_client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": user_content},
                ],
                temperature=temperature,
            )
            processed_content = response.choices[0].message.content
            if processed_content:
                return {
                    "processed_text": processed_content,
                    "error": "",
                    "retryable": False,
                    "attempts": attempt,
                    "model": model,
                }
            return {
                "processed_text": "",
                "error": "OpenAI returned empty content.",
                "retryable": False,
                "attempts": attempt,
                "model": model,
            }
        except Exception as exception:
            last_exception = exception
            retryable = _is_retryable_exception(exception)
            if attempt < max_retries and retryable:
                time.sleep(_retry_wait_seconds(attempt))
                continue
            return {
                "processed_text": "",
                "error": f"Error during PDF parser call: {exception}",
                "retryable": retryable,
                "attempts": attempt,
                "model": model,
            }
    return {
        "processed_text": "",
        "error": f"Error during PDF parser call: {last_exception}",
        "retryable": True,
        "attempts": max_retries,
        "model": model,
    }


def call_gemini_pdf_upload_with_metadata(
    gemini_client: Any,
    pdf_path: str,
    prompt: str,
    *,
    model: str,
    max_retries: int = 3,
) -> dict[str, Any]:
    """Upload a PDF to Gemini and return text plus retry metadata."""
    last_exception: Exception | None = None
    for attempt in range(1, max_retries + 1):
        try:
            uploaded_file = gemini_client.files.upload(file=pdf_path)
            response = gemini_client.models.generate_content(
                model=model,
                contents=[prompt, uploaded_file],
            )
            processed_text = getattr(response, "text", "") or ""
            if processed_text:
                return {
                    "processed_text": processed_text,
                    "error": "",
                    "retryable": False,
                    "attempts": attempt,
                    "model": model,
                }
            return {
                "processed_text": "",
                "error": "Gemini returned empty content.",
                "retryable": False,
                "attempts": attempt,
                "model": model,
            }
        except Exception as exception:
            last_exception = exception
            retryable = _is_retryable_exception(exception)
            if attempt < max_retries and retryable:
                time.sleep(_retry_wait_seconds(attempt))
                continue
            return {
                "processed_text": "",
                "error": f"Gemini fallback failed ({exception})",
                "retryable": retryable,
                "attempts": attempt,
                "model": model,
            }
    return {
        "processed_text": "",
        "error": f"Gemini fallback failed ({last_exception})",
        "retryable": True,
        "attempts": max_retries,
        "model": model,
    }


def extract_pdf_text_whisper_with_metadata(
    file_path: str,
    file_name: str,
    whisper_client: Any,
    page: str | int,
    *,
    profile_name: str = "high_quality",
    profile_settings: dict[str, Any] | None = None,
    max_retries: int = 3,
) -> dict[str, Any]:
    """Extract PDF text with retry metadata so callers can spot upstream pressure."""
    file = os.path.join(file_path, file_name)
    last_exception: Exception | None = None
    resolved_profile = profile_settings or {
        "mode": "high_quality",
        "mark_horizontal_lines": True,
        "mark_vertical_lines": True,
    }

    for attempt in range(1, max_retries + 1):
        try:
            time.sleep(0.25)
            whisper_kwargs = {
                "file_path": file,
                "wait_for_completion": True,
                "wait_timeout": 600,
                "output_mode": "layout_preserving",
                "mode": resolved_profile["mode"],
                "mark_horizontal_lines": resolved_profile["mark_horizontal_lines"],
                "mark_vertical_lines": resolved_profile["mark_vertical_lines"],
                "add_line_nos": True,
                "tag": Path(file_name).stem,
                "filename": Path(file_name).name,
            }

            if page == "all":
                whisper = whisper_client.whisper(**whisper_kwargs)
            else:
                whisper = whisper_client.whisper(pages_to_extract=page, **whisper_kwargs)

            extraction = whisper.get("extraction", {})
            if "result_text" not in extraction:
                response_keys = (
                    sorted(whisper.keys()) if isinstance(whisper, dict) else type(whisper).__name__
                )
                extraction_keys = (
                    sorted(extraction.keys())
                    if isinstance(extraction, dict)
                    else type(extraction).__name__
                )
                status = whisper.get("status", "")
                status_code = whisper.get("status_code", "")
                message = whisper.get("message", "")
                error_parts = [
                    "Whisper response missing extraction.result_text",
                    f"response_keys={response_keys}",
                    f"extraction_keys={extraction_keys}",
                ]
                if status:
                    error_parts.append(f"status={status}")
                if status_code != "":
                    error_parts.append(f"status_code={status_code}")
                if message:
                    error_parts.append(f"message={message}")
                return {
                    "text": "",
                    "error": "; ".join(error_parts),
                    "retryable": False,
                    "attempts": attempt,
                    "profile_name": profile_name,
                    "profile_settings": resolved_profile,
                }
            return {
                "text": extraction["result_text"],
                "error": "",
                "retryable": False,
                "attempts": attempt,
                "profile_name": profile_name,
                "profile_settings": resolved_profile,
                "whisper_hash": extraction.get("whisper_hash") or whisper.get("whisper_hash"),
                "confidence_metadata": extraction.get("confidence_metadata", {}),
                "raw_extraction_metadata": extraction,
            }
        except (LLMWhispererClientException, ReadTimeout, ConnectionError, Timeout) as exception:
            last_exception = exception
            retryable = _is_retryable_exception(exception)
            if attempt < max_retries and retryable:
                time.sleep(_retry_wait_seconds(attempt))
                continue
            if isinstance(exception, LLMWhispererClientException):
                return {
                    "text": "",
                    "error": str(exception),
                    "retryable": retryable,
                    "attempts": attempt,
                    "profile_name": profile_name,
                    "profile_settings": resolved_profile,
                    "failure_kind": "api_failed",
                    "error_type": type(exception).__name__,
                }
            raise
    return {
        "text": "",
        "error": str(last_exception) if last_exception is not None else "Whisper extraction failed",
        "retryable": bool(last_exception and _is_retryable_exception(last_exception)),
        "attempts": max_retries,
        "profile_name": profile_name,
        "profile_settings": resolved_profile,
        "failure_kind": "api_failed",
        "error_type": type(last_exception).__name__
        if last_exception is not None
        else "LLMWhispererClientException",
    }


def clean_units_llm(unit_string: str, gemini_client: Any) -> str:
    """Clean a unit string with Gemini using the standard prompt."""
    instructions = load_prompt("clean_units_prompt.md")
    prompt = f"{instructions}\n\nclean this text following your instructions: {unit_string}"
    return call_gemini_api(prompt, gemini_client)


def extract_weight_llm(
    unit_string: str, gemini_client: Any, custom_prompt: str | None = None
) -> str:
    """Extract weight from a unit string with Gemini."""
    instructions = custom_prompt or load_prompt("extract_weight_prompt.md")
    prompt = f"{instructions}\n\nclean this text following your instructions: {unit_string}"
    return call_gemini_api(
        prompt,
        gemini_client,
        model=DEFAULT_WEIGHT_EXTRACTION_MODEL,
    )


def LLM_process_extracted_pdf_text_experimental(
    OpenAI_client: OpenAI,
    extracted_text: str | LLMWhispererClientException,
    prompt: str | None = None,
) -> str:
    """
    Process extracted PDF text using the experimental OpenAI responses endpoint.
    """
    if prompt is None:
        raise ValueError("Prompt must be provided")

    response = OpenAI_client.responses.create(
        model="gpt-4.1",
        instructions=prompt,
        input=(
            "extract this text following your prompt. Please extract every page of the text "
            f"I give you and do not truncate the output {extracted_text}. Please every page. "
            "do NOT stop until you have extracted every page of the table. Do not ask for the "
            "users permission to continue."
        ),
        temperature=0.0,
        tool_choice="none",
    )
    return response.output_text


def LLM_process_extracted_pdf_text(
    OpenAI_client: OpenAI,
    extracted_text: str | LLMWhispererClientException,
    prompt: str | None = None,
) -> str:
    """
    Process single-page extracted PDF text into markdown table using OpenAI.
    """
    if isinstance(extracted_text, LLMWhispererClientException):
        print(f"LLMWhispererClientException occurred: {extracted_text}")
        return ""
    if not extracted_text:
        print("No extracted text provided to LLM_process_extracted_pdf_text.")
        return ""

    if prompt is None:
        prompt = load_prompt("extract_pdf_prompt.md")

    result = call_openai_prompt_with_metadata(
        openai_client=OpenAI_client,
        prompt=prompt,
        user_content=extracted_text,
        model=DEFAULT_PDF_MODEL,
    )
    if result["error"]:
        print(result["error"])
    return result["processed_text"]


def experimental_csv_extraction_to_markdown(
    csv_data: str,
    openai_client: Any,
    model: str = "gpt-4.1",
) -> str:
    """Convert noisy CSV text to markdown table via OpenAI."""
    prompt = (
        "\n"
        "This text is from a CSV file that I have read into Python using f.read.\n"
        "It is catering data that contains an item description alongside the sales and "
        "quantities for a variety of months, as well as the approximate case weight.\n"
        "The CSV has a load of other stuff that I'm not interested in.\n"
        "Please reformat this text into a markdown table I can later read into python as a "
        "dataframe.\n"
        "Only output a markdown table of the data and nothing else. Do not explain the "
        "output, just return it.\n"
        "DO NOT return in a codeblock.\n"
        "Just return the raw text in markdown format.\n"
        "It should contain  only the item description,\n"
        "the sales for various months, the quantity for various months and the approximate "
        "case weight. Where you encounter empty data, please just put an NAN there.\n"
        "The first few rows may not contain useful information. They may contain metadata.\n"
    )

    response = openai_client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": prompt},
            {
                "role": "user",
                "content": f"extract this text following your prompt: {csv_data}",
            },
        ],
        temperature=0.0,
    )
    return response.choices[0].message.content
