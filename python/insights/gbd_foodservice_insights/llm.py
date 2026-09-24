"""
Provider clients and transport for the Foodservice Insights package.

This module owns how we reach OpenAI and Gemini: client construction, the Gemini model registry,
and the thin call wrappers every LLM-backed helper goes through. Prompt text lives in
`llm_prompts`; the task-specific helpers live in `categorize_llm` and `llm_extraction`.
"""

import json
import os
from functools import lru_cache
from typing import Any

from google import genai
from google.genai import types
from openai import OpenAI

from gbd_foodservice_insights import PACKAGE_DIR

GEMINI_MODEL_CONFIG_PATH = PACKAGE_DIR / "data_files" / "gemini_models.json"
DEFAULT_GEMINI_FLASH_MODEL_KEY = "utils.call_gemini_api_default"


@lru_cache(maxsize=1)
def load_gemini_model_config() -> dict[str, str]:
    """Load the repo-level Gemini model mapping."""
    with GEMINI_MODEL_CONFIG_PATH.open("r", encoding="utf-8") as handle:
        config = json.load(handle)

    if not isinstance(config, dict):
        raise ValueError(
            f"Gemini model config at {GEMINI_MODEL_CONFIG_PATH} must be a JSON object."
        )

    invalid_entries = [
        key for key, value in config.items() if not isinstance(value, str) or not value.strip()
    ]
    if invalid_entries:
        raise ValueError(
            "Gemini model config contains empty or non-string values for: "
            + ", ".join(sorted(invalid_entries))
        )

    return config


def get_gemini_model(config_key: str) -> str:
    """Return the configured Gemini model for a known call site."""
    config = load_gemini_model_config()
    try:
        return config[config_key]
    except KeyError as exc:
        raise KeyError(
            f"Gemini model config is missing key '{config_key}' in {GEMINI_MODEL_CONFIG_PATH}."
        ) from exc


DEFAULT_GEMINI_MODEL = get_gemini_model(DEFAULT_GEMINI_FLASH_MODEL_KEY)
DEFAULT_CATEGORIZATION_MODEL = "gpt-4.1-mini"


def _build_gemini_thinking_config(model: str) -> types.ThinkingConfig:
    """Use Gemini 3 thinking levels while keeping older models backwards-compatible."""
    if model.startswith("gemini-3.1-pro"):
        return types.ThinkingConfig(thinking_level="low")
    if model.startswith("gemini-3"):
        return types.ThinkingConfig(thinking_level="minimal")
    return types.ThinkingConfig(thinking_budget=0)


def setup_api_clients(
    openai: bool = False, whisper: bool = False, gemini: bool = False
) -> dict[str, Any]:
    """
    Initialize API clients based on requested services.

    Args:
        openai: Whether to initialize OpenAI client.
        whisper: Whether to initialize LLM Whisperer client.
        gemini: Whether to initialize Gemini client.

    Returns:
        Dictionary with requested clients (keys: openai_client, whisper_client, gemini_client).

    Raises:
        ValueError: If required API keys are not set in environment variables.
    """
    clients: dict[str, Any] = {}

    if openai:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY must be set in environment variables")
        clients["openai_client"] = OpenAI(api_key=api_key)

    if whisper:
        # Imported here rather than at module scope: LLM Whisperer is only used by PDF extraction,
        # which is on its way to a separate lab package. Deferring the import keeps everything
        # else in this module importable without llmwhisperer-client installed.
        from unstract.llmwhisperer import LLMWhispererClientV2  # ty: ignore[unresolved-import]

        api_key = os.getenv("LLM_WHISPERER_API_KEY")
        if not api_key:
            raise ValueError("LLM_WHISPERER_API_KEY must be set in environment variables")
        clients["whisper_client"] = LLMWhispererClientV2(api_key=api_key, logging_level="INFO")

    if gemini:
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise ValueError("GEMINI_API_KEY must be set in environment variables")
        clients["gemini_client"] = genai.Client(api_key=api_key)

    return clients


def call_gemini_api(
    prompt: str,
    gemini_client: Any,
    temperature: float = 0.0,
    model: str = DEFAULT_GEMINI_MODEL,
) -> str:
    """
    Make a consistent Gemini API call with configurable temperature.
    """
    response = gemini_client.models.generate_content(
        model=model,
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=temperature,
            thinking_config=_build_gemini_thinking_config(model),
        ),
    )
    return response.text.strip()


def openai_chat_completion(
    openai_client: Any,
    system_prompt: str,
    user_prompt: str,
    model: str = DEFAULT_CATEGORIZATION_MODEL,
    max_tokens: int = 30,
    temperature: float = 0.0,
) -> str:
    """Shared OpenAI chat completion wrapper."""
    if openai_client is None:
        raise ValueError("openai_client is required.")

    response = openai_client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        max_tokens=max_tokens,
        temperature=temperature,
    )
    return response.choices[0].message.content.strip()
