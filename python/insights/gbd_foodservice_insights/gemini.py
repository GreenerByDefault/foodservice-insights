"""
The Gemini model registry and call wrapper, for serving-mode entree detection and the lab.

Prompt text lives in `llm_prompts`; categorization's OpenAI calls live in `categorization.llm`;
the lab builds its provider clients with `notebook_runscript_setup.setup_api_clients`.
"""

import json
from functools import lru_cache
from typing import Any

from google.genai import types

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


def _build_gemini_thinking_config(model: str) -> types.ThinkingConfig:
    """Use Gemini 3 thinking levels while keeping older models backwards-compatible."""
    if model.startswith("gemini-3.1-pro"):
        return types.ThinkingConfig(thinking_level="low")
    if model.startswith("gemini-3"):
        return types.ThinkingConfig(thinking_level="minimal")
    return types.ThinkingConfig(thinking_budget=0)


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
