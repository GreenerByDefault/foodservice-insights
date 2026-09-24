"""
LLM helpers for categorization: the prompt each task uses and the shape of its answer.

Transport lives in `llm`; these functions only choose a prompt, format the item, and hand the
result back as a string.
"""

import re
from collections.abc import Sequence
from typing import Any

from gbd_foodservice_insights.llm import call_gemini_api, openai_chat_completion
from gbd_foodservice_insights.llm_prompts import load_prompt


def clean_product_name(item: str, openai_client: Any, max_tokens: int = 30) -> str:
    """Clean a food item name using OpenAI."""
    system_prompt = load_prompt("clean_item_name_prompt.md")
    cleaned_item = re.sub(r"\(\d+\)", "", item).replace(".", "").strip()
    result = openai_chat_completion(
        openai_client=openai_client,
        system_prompt=system_prompt,
        user_prompt=f"classify {cleaned_item} according to your instructions",
        max_tokens=max_tokens,
    )
    return result.lower()


def match_product_to_category(
    item: str,
    categories: Sequence[str],
    openai_client: Any,
    max_tokens: int = 30,
) -> str:
    """Match a food item to a GBD category using OpenAI."""
    system_prompt_template = load_prompt("match_items_to_gbd_categories_prompt.md")
    try:
        system_prompt = system_prompt_template.format(categories=list(categories))
    except KeyError as err:
        raise ValueError("Placeholder {categories} not found in prompt template") from err

    cleaned_item = re.sub(r"\(\d+\)", "", item).replace(".", "").strip()
    return openai_chat_completion(
        openai_client=openai_client,
        system_prompt=system_prompt,
        user_prompt=f"classify {cleaned_item} according to your instructions",
        max_tokens=max_tokens,
    )


def fuzzy_match_category(
    item: str,
    categories: Sequence[str],
    openai_client: Any,
    max_tokens: int = 30,
) -> str:
    """Fuzzy-match a string to one of the provided categories using OpenAI."""
    system_prompt_template = load_prompt("fuzzy_match_gbd_category_prompt.md")
    try:
        system_prompt = system_prompt_template.format(categories=list(categories))
    except KeyError as err:
        raise ValueError("Placeholder {categories} not found in prompt template") from err

    return openai_chat_completion(
        openai_client=openai_client,
        system_prompt=system_prompt,
        user_prompt=f"classify {item} according to your instructions",
        max_tokens=max_tokens,
    )


def classify_entree(product: str, gemini_client: Any) -> str:
    """Classify a product as entree/non-entree using Gemini."""
    if gemini_client is None:
        raise ValueError("gemini_client is required for entree detection.")
    entree_detector_prompt = load_prompt("entree_detector_prompt.md")
    prompt = f"{entree_detector_prompt}\n\nProduct: {product}"
    return call_gemini_api(prompt, gemini_client)
