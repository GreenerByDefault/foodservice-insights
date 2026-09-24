"""
LLM operations for categorization, behind a protocol so the pipeline never sees a provider.

`OpenAiLlmClient` is the real implementation and the place a provider swap happens;
`gbd_foodservice_insights.testing.KeywordLlmClient` is the offline one.
"""

import logging
import os
import random
import re
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Final, Protocol

import openai

from gbd_foodservice_insights.errors import UpstreamApiError
from gbd_foodservice_insights.llm import call_gemini_api
from gbd_foodservice_insights.llm_prompts import load_prompt

logger = logging.getLogger(__name__)


class LlmClient(Protocol):
    def clean_product_name(self, item: str) -> str:
        """A procurement line's product name, reduced to the food or drink it refers to."""
        ...

    def match_product_to_category(self, item: str, categories: Sequence[str]) -> str:
        """One of `categories` for a cleaned name — or anything else when none fits, which
        the pipeline treats as uncategorized."""
        ...

    def fuzzy_match_category(self, item: str, categories: Sequence[str]) -> str:
        """The one of `categories` a near-miss label was meant to be."""
        ...


# This class is the one retry layer for LLM calls (`apps/worker/src/failures.ts`
# § one-retry-layer), so the SDK's own retries must stay off: `from_env` sets `max_retries=0`.
#
# Worst case for one call: MAX_ATTEMPTS request timeouts plus the backoff between them,
# 5 × 30 s + (2 + 4 + 8 + 16 + 4 × jitter) s ≈ 3 min — well inside the parent's ten-minute
# `killAfterNoProgressMs`, since progress is only reported between calls.
MAX_ATTEMPTS: Final = 5
REQUEST_TIMEOUT_S: Final = 30.0
# Worth another attempt: the request may succeed unchanged. Everything else (400, 401, 403,
# 404, 422, …) is a bug or a misconfiguration on our side, so it propagates as-is and fails the
# run as `unknown` rather than inviting the user to retry something that cannot succeed.
RETRYABLE_STATUS_CODES: Final = frozenset({408, 409, 425, 429, 500, 502, 503, 504})

DEFAULT_MODEL: Final = "gpt-4.1-mini"
MAX_TOKENS: Final = 30


def _is_retryable(error: openai.APIError) -> bool:
    # `APITimeoutError` is a subclass of `APIConnectionError`.
    if isinstance(error, openai.APIConnectionError):
        return True
    return isinstance(error, openai.APIStatusError) and error.status_code in RETRYABLE_STATUS_CODES


def _strip_pack_counts(item: str) -> str:
    return re.sub(r"\(\d+\)", "", item).replace(".", "").strip()


def _categories_prompt(template_name: str, categories: Sequence[str]) -> str:
    template = load_prompt(template_name)
    try:
        return template.format(categories=list(categories))
    except KeyError as err:
        raise ValueError("Placeholder {categories} not found in prompt template") from err


@dataclass(frozen=True)
class OpenAiLlmClient:
    client: openai.OpenAI
    model: str = DEFAULT_MODEL
    sleep: Callable[[float], None] = time.sleep

    @classmethod
    def from_env(cls) -> OpenAiLlmClient:
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY must be set in environment variables")
        return cls(openai.OpenAI(api_key=api_key, max_retries=0, timeout=REQUEST_TIMEOUT_S))

    def clean_product_name(self, item: str) -> str:
        return self._complete(
            load_prompt("clean_item_name_prompt.md"),
            f"classify {_strip_pack_counts(item)} according to your instructions",
        ).lower()

    def match_product_to_category(self, item: str, categories: Sequence[str]) -> str:
        return self._complete(
            _categories_prompt("match_items_to_gbd_categories_prompt.md", categories),
            f"classify {_strip_pack_counts(item)} according to your instructions",
        )

    def fuzzy_match_category(self, item: str, categories: Sequence[str]) -> str:
        return self._complete(
            _categories_prompt("fuzzy_match_gbd_category_prompt.md", categories),
            f"classify {item} according to your instructions",
        )

    def _complete(self, system_prompt: str, user_prompt: str) -> str:
        attempt = 1
        while True:
            try:
                response = self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    max_tokens=MAX_TOKENS,
                    temperature=0.0,
                )
            except openai.APIError as err:
                if not _is_retryable(err):
                    raise
                if attempt == MAX_ATTEMPTS:
                    raise UpstreamApiError(
                        f"OpenAI failed {MAX_ATTEMPTS} times; last error: {err}"
                    ) from err
                logger.warning("OpenAI attempt %d/%d failed: %s", attempt, MAX_ATTEMPTS, err)
                self.sleep(2**attempt + random.random())
                attempt += 1
                continue

            content = response.choices[0].message.content
            if content is None:
                raise ValueError(f"OpenAI returned no content: {response!r}")
            return content.strip()


def classify_entree(product: str, gemini_client: Any) -> str:
    """Classify a product as entree/non-entree using Gemini."""
    if gemini_client is None:
        raise ValueError("gemini_client is required for entree detection.")
    entree_detector_prompt = load_prompt("entree_detector_prompt.md")
    prompt = f"{entree_detector_prompt}\n\nProduct: {product}"
    return call_gemini_api(prompt, gemini_client)
