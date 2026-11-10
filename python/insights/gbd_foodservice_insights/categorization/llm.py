"""
LLM operations for categorization, behind a protocol so the pipeline never sees a provider.

`AnthropicLlmClient` is the real implementation and the place a provider swap happens;
`gbd_foodservice_insights.testing.KeywordLlmClient` is the offline one. Only the real one
reports what its calls used, since only it spends anything.
"""

import logging
import os
import random
import re
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, Literal, Protocol

import anthropic
from anthropic.types import Message, ThinkingConfigParam

from gbd_foodservice_insights.errors import UpstreamApiError
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


# This class is the one retry layer for LLM calls (`apps/worker/src/failures.ts`
# § one-retry-layer), so `_complete` turns the SDK's own retries off on whatever client it is
# given, rather than trusting whoever built that client to have done so.
#
# Worst case for one call: MAX_ATTEMPTS request timeouts plus the backoff between them,
# 5 × 30 s + (2 + 4 + 8 + 16 + 4 × jitter) s ≈ 3 min — well inside the parent's ten-minute
# `killAfterNoProgressMs`, since progress is only reported between calls.
MAX_ATTEMPTS: Final = 5
REQUEST_TIMEOUT_S: Final = 30.0
# Worth another attempt: the request may succeed unchanged. Everything else (400, 401, 403,
# 404, 422, …) is a bug or a misconfiguration on our side, so it propagates as-is and fails the
# run as `unknown` rather than inviting the user to retry something that cannot succeed.
RETRYABLE_STATUS_CODES: Final = frozenset({408, 409, 425, 429, 500, 502, 503, 504, 529})

# How many LLM calls one analysis has in flight at once. The account's rate limits see
# workers × `maxConcurrentAttempts` × this, and a 429 storm costs this × MAX_ATTEMPTS requests
# before the run fails as `upstream_api`. Nothing checks that product against the limits: no
# single process knows how many workers are running, so `WORKER_MAX_CONCURRENT_ATTEMPTS` is the
# lever to pull in an incident. Conservative until measured.
# *Rejected: a worker config field checked in `apps/worker/src/config.ts`* — its relations need
# the fleet size and the account's limits, neither of which that file knows either.
# *Rejected: `asyncio` in place of the thread pool (`utils.py`)* — a handful of blocking calls
# runs fine on threads, and `asyncio` would make every caller up the pipeline async.
LLM_CONCURRENCY: Final = 3

DEFAULT_MODEL: Final = "claude-sonnet-5-5"


@dataclass(frozen=True)
class ModelPrice:
    """List price, in micro-USD per million tokens. `cached_input` is the cache-read price."""

    input: int
    cached_input: int
    output: int


@dataclass(frozen=True)
class ModelSettings:
    price: ModelPrice
    # How the request turns thinking off; None for a model whose thinking cannot be turned off,
    # which `effort: low` keeps short instead.
    thinking: ThinkingConfigParam | None
    # An answer is a name or a category, ~10 tokens; thinking counts toward the cap too.
    max_tokens: int


# Prices from https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-11-10, for
# prompts under Haiku's 100,000-token threshold. `AnthropicLlmClient` refuses a model missing
# here, so a model switch cannot ship unpriced.
#
# Cache writes bill at 1.25x input but are priced here as plain input, since `LlmCall` has no
# field for them. A run writes each system prompt only a few times (its first `LLM_CONCURRENCY`
# calls, and again after five idle minutes), so that undercounts it by a fraction of a cent.
MODELS: Final[Mapping[str, ModelSettings]] = {
    "claude-haiku-5-5": ModelSettings(
        ModelPrice(input=100_000, cached_input=10_000, output=500_000),
        thinking={"type": "disabled"},
        max_tokens=30,
    ),
    # `disabled` is a 400 on Sonnet 5.5; `between_tools` is its thinking-off setting.
    "claude-sonnet-5-5": ModelSettings(
        ModelPrice(input=2_000_000, cached_input=100_000, output=10_000_000),
        thinking={"type": "between_tools"},
        max_tokens=30,
    ),
    "claude-opus-5-5": ModelSettings(
        ModelPrice(input=4_000_000, cached_input=200_000, output=20_000_000),
        thinking=None,
        max_tokens=2_000,
    ),
}


def cost_micro_usd(
    model: str, *, input_tokens: int, cached_input_tokens: int, output_tokens: int
) -> int:
    """List-price cost, rounded half up. `input_tokens` includes the cached ones. Round once,
    over a whole total, rather than per call and summing."""
    if not 0 <= cached_input_tokens <= input_tokens or output_tokens < 0:
        raise ValueError(
            f"Impossible token counts: {input_tokens} input, {cached_input_tokens} cached, "
            f"{output_tokens} output"
        )
    price = MODELS[model].price
    micro_usd_per_million = (
        (input_tokens - cached_input_tokens) * price.input
        + cached_input_tokens * price.cached_input
        + output_tokens * price.output
    )
    return (micro_usd_per_million + 500_000) // 1_000_000


LlmOperation = Literal["clean", "match"]


@dataclass(frozen=True)
class LlmCall:
    """What one `LlmClient` call used, across all of its retries. Only the last request can have
    succeeded, so the usage is that response's, and is zero when none arrived."""

    operation: LlmOperation
    requested_model: str
    served_model: str | None  # the snapshot the alias resolved to; None when nothing answered
    requests: int
    failed_requests: int
    rate_limited_requests: int  # 429s, among the failed ones
    truncated: bool  # the answer hit the model's `max_tokens`
    input_tokens: int  # cached included
    cached_input_tokens: int
    output_tokens: int


type OnLlmCall = Callable[[LlmCall], None]


def _ignore_call(call: LlmCall) -> None:
    pass


def _is_retryable(error: anthropic.APIError) -> bool:
    # `APITimeoutError` is a subclass of `APIConnectionError`.
    if isinstance(error, anthropic.APIConnectionError):
        return True
    return (
        isinstance(error, anthropic.APIStatusError) and error.status_code in RETRYABLE_STATUS_CODES
    )


def _strip_pack_counts(item: str) -> str:
    return re.sub(r"\(\d+\)|\.(?!\d)", "", item).strip()


def _categories_prompt(template_name: str, categories: Sequence[str]) -> str:
    template = load_prompt(template_name)
    return template.format(categories="\n".join(categories))


def _llm_call(
    operation: LlmOperation,
    model: str,
    response: Message | None,
    *,
    requests: int,
    rate_limited_requests: int,
) -> LlmCall:
    usage = response.usage if response is not None else None
    cache_read = (usage.cache_read_input_tokens or 0) if usage is not None else 0
    cache_write = (usage.cache_creation_input_tokens or 0) if usage is not None else 0
    return LlmCall(
        operation=operation,
        requested_model=model,
        served_model=response.model if response is not None else None,
        requests=requests,
        # A response ends the call, so at most the last request succeeded.
        failed_requests=requests if response is None else requests - 1,
        rate_limited_requests=rate_limited_requests,
        truncated=response is not None and response.stop_reason == "max_tokens",
        # Anthropic's `input_tokens` leaves out cache reads and writes; ours includes both.
        input_tokens=(usage.input_tokens + cache_read + cache_write) if usage is not None else 0,
        cached_input_tokens=cache_read,
        output_tokens=usage.output_tokens if usage is not None else 0,
    )


# *Rejected: server-side `fallbacks`.* They retry only `cyber` and `frontier_llm` refusals, which
# a product name will not draw, and would make the served model, and so the price, vary per call.
def _answer(response: Message) -> str:
    if response.stop_reason == "refusal":
        category = response.stop_details.category if response.stop_details else None
        raise ValueError(f"Claude refused to answer (category: {category}): {response!r}")
    # A response can open with a thinking block, so find the text by type, not position.
    text = "".join(block.text for block in response.content if block.type == "text")
    if not text.strip():
        raise ValueError(f"Claude returned no text: {response!r}")
    return text.strip()


@dataclass(frozen=True)
class AnthropicLlmClient:
    """`on_call` hears about every call exactly once, however it ended, from whichever thread
    made it."""

    client: anthropic.Anthropic
    model: str = DEFAULT_MODEL
    sleep: Callable[[float], None] = time.sleep
    on_call: OnLlmCall = _ignore_call

    def __post_init__(self) -> None:
        if self.model not in MODELS:
            raise ValueError(f"{self.model!r} has no settings in MODELS")

    @classmethod
    def from_env(cls, *, on_call: OnLlmCall = _ignore_call) -> AnthropicLlmClient:
        # Passed explicitly so the SDK cannot fall back to a profile or token on the machine.
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY must be set in environment variables")
        return cls(anthropic.Anthropic(api_key=api_key), on_call=on_call)

    def clean_product_name(self, item: str) -> str:
        return self._complete(
            "clean",
            load_prompt("clean_item_name_prompt.md"),
            f"classify {_strip_pack_counts(item)} according to your instructions",
        ).lower()

    def match_product_to_category(self, item: str, categories: Sequence[str]) -> str:
        return self._complete(
            "match",
            _categories_prompt("match_items_to_gbd_categories_prompt.md", categories),
            f"classify {_strip_pack_counts(item)} according to your instructions",
        )

    def _complete(self, operation: LlmOperation, system_prompt: str, user_prompt: str) -> str:
        client = self.client.with_options(max_retries=0, timeout=REQUEST_TIMEOUT_S)
        settings = MODELS[self.model]
        requests = 0
        rate_limited_requests = 0
        response: Message | None = None
        try:
            while True:
                requests += 1
                try:
                    response = client.messages.create(
                        model=self.model,
                        # Each operation's system prompt is the same on every call, so it is
                        # cached; the product name follows it.
                        system=[
                            {
                                "type": "text",
                                "text": system_prompt,
                                "cache_control": {"type": "ephemeral"},
                            }
                        ],
                        messages=[{"role": "user", "content": user_prompt}],
                        max_tokens=settings.max_tokens,
                        output_config={"effort": "low"},
                        thinking=settings.thinking or anthropic.omit,
                    )
                except anthropic.APIError as err:
                    if isinstance(err, anthropic.RateLimitError):
                        rate_limited_requests += 1
                    if not _is_retryable(err):
                        raise
                    if requests == MAX_ATTEMPTS:
                        raise UpstreamApiError(
                            f"Claude failed {MAX_ATTEMPTS} times; last error: {err}"
                        ) from err
                    logger.warning("Claude attempt %d/%d failed: %s", requests, MAX_ATTEMPTS, err)
                    self.sleep(2**requests + random.random())
                    continue

                return _answer(response)
        finally:
            self.on_call(
                _llm_call(
                    operation,
                    self.model,
                    response,
                    requests=requests,
                    rate_limited_requests=rate_limited_requests,
                )
            )
