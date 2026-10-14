from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Literal, cast

import httpx
import openai
import pytest
from gbd_foodservice_insights.categorization.llm import (
    MAX_ATTEMPTS,
    REQUEST_TIMEOUT_S,
    LlmCall,
    OpenAiLlmClient,
    cost_micro_usd,
)
from gbd_foodservice_insights.errors import UpstreamApiError
from openai.types.chat import ChatCompletion, ChatCompletionMessage
from openai.types.chat.chat_completion import Choice
from openai.types.completion_usage import CompletionUsage, PromptTokensDetails

_REQUEST = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")


def _status_error(status_code: int) -> openai.APIStatusError:
    # The SDK's own mapping from a status code to its exception class, so a 429 is a
    # `RateLimitError` exactly as it would be in production.
    response = httpx.Response(status_code, request=_REQUEST)
    return openai.OpenAI(api_key="unused")._make_status_error_from_response(response)


SERVED_MODEL = "gpt-4.1-mini-2025-04-14"
DEFAULT_USAGE = CompletionUsage(prompt_tokens=1000, completion_tokens=5, total_tokens=1005)


def _completion(
    content: str | None,
    *,
    usage: CompletionUsage | None = DEFAULT_USAGE,
    finish_reason: Literal["stop", "length"] = "stop",
) -> ChatCompletion:
    return ChatCompletion(
        id="chatcmpl-test",
        object="chat.completion",
        created=0,
        model=SERVED_MODEL,
        choices=[
            Choice(
                index=0,
                finish_reason=finish_reason,
                message=ChatCompletionMessage(role="assistant", content=content),
            )
        ],
        usage=usage,
    )


# A bare string or None is shorthand for a completion with that content and `DEFAULT_USAGE`.
type Outcome = Exception | ChatCompletion | str | None


@dataclass
class FakeOpenAi:
    """Stands in for `openai.OpenAI`: each `create` call pops the next scripted outcome."""

    outcomes: list[Outcome]
    requests: list[dict[str, Any]] = field(default_factory=list)
    options: dict[str, Any] = field(default_factory=dict)

    def with_options(self, **options: Any) -> FakeOpenAi:
        self.options = options
        return self

    @property
    def chat(self) -> Any:
        return SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kwargs: Any) -> Any:
        self.requests.append(kwargs)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome if isinstance(outcome, ChatCompletion) else _completion(outcome)


def _client(*outcomes: Outcome) -> tuple[OpenAiLlmClient, FakeOpenAi, list[float]]:
    client, fake, sleeps, _ = _reporting_client(*outcomes)
    return client, fake, sleeps


def _reporting_client(
    *outcomes: Outcome,
) -> tuple[OpenAiLlmClient, FakeOpenAi, list[float], list[LlmCall]]:
    fake = FakeOpenAi(list(outcomes))
    sleeps: list[float] = []
    calls: list[LlmCall] = []
    client = OpenAiLlmClient(cast(openai.OpenAI, fake), sleep=sleeps.append, on_call=calls.append)
    return client, fake, sleeps, calls


def _call(**overrides: Any) -> LlmCall:
    """The `LlmCall` for one `clean` request answered with `DEFAULT_USAGE`, with `overrides`."""
    defaults: dict[str, Any] = {
        "operation": "clean",
        "model": "gpt-4.1-mini",
        "served_model": SERVED_MODEL,
        "requests": 1,
        "failed_requests": 0,
        "rate_limited_requests": 0,
        "truncated": False,
        "input_tokens": 1000,
        "cached_input_tokens": 0,
        "output_tokens": 5,
    }
    return LlmCall(**(defaults | overrides))


def test_retries_transient_failures_with_exponential_backoff() -> None:
    client, fake, sleeps = _client(
        _status_error(429),
        openai.APIConnectionError(request=_REQUEST),
        openai.APITimeoutError(request=_REQUEST),
        _status_error(503),
        "  Cheese \n",
    )

    assert client.match_product_to_category("cheddar", ["Cheese"]) == "Cheese"
    assert len(fake.requests) == MAX_ATTEMPTS
    assert [int(s) for s in sleeps] == [2, 4, 8, 16]


def test_exhausted_retries_raise_upstream_api_error() -> None:
    client, fake, sleeps = _client(*[_status_error(500)] * MAX_ATTEMPTS)

    with pytest.raises(UpstreamApiError, match="failed 5 times"):
        client.clean_product_name("cheddar")

    assert len(fake.requests) == MAX_ATTEMPTS
    # Each attempt also has its own request timeout; this is only the backoff between them.
    assert sum(sleeps) < 35


@pytest.mark.parametrize("status_code", [400, 401, 403, 404, 422])
def test_non_transient_failures_propagate_without_retrying(status_code: int) -> None:
    client, fake, sleeps = _client(_status_error(status_code))

    with pytest.raises(openai.APIStatusError) as excinfo:
        client.match_product_to_category("chese", ["Cheese"])

    assert not isinstance(excinfo.value, UpstreamApiError)
    assert excinfo.value.status_code == status_code
    assert len(fake.requests) == 1
    assert sleeps == []


def test_empty_content_is_an_error() -> None:
    client, _, _ = _client(None)

    with pytest.raises(ValueError, match="no content"):
        client.clean_product_name("cheddar")


def test_clean_product_name_strips_pack_counts_and_lowercases() -> None:
    client, fake, _ = _client("Cheddar Cheese")

    assert client.clean_product_name("CHEDDAR (12) .5 2.5 5.LB") == "cheddar cheese"
    messages = fake.requests[0]["messages"]
    assert messages[1] == {
        "role": "user",
        "content": "classify CHEDDAR  .5 2.5 5LB according to your instructions",
    }


def test_match_prompt_lists_the_categories() -> None:
    client, fake, _ = _client("Cheese")

    client.match_product_to_category("cheddar", ["Cheese", "Butter"])

    assert "\nCheese\nButter\n" in fake.requests[0]["messages"][0]["content"]
    assert 'say "None"' not in fake.requests[0]["messages"][0]["content"]
    assert "No Matches Found" in fake.requests[0]["messages"][0]["content"]


def test_match_returns_the_models_text_untouched() -> None:
    client, _, _ = _client('"Cheese."')

    assert client.match_product_to_category("cheddar", ["Cheese"]) == '"Cheese."'


def test_requests_go_out_with_sdk_retries_off() -> None:
    client, fake, _ = _client("Cheese")

    client.clean_product_name("cheddar")

    assert fake.options == {"max_retries": 0, "timeout": REQUEST_TIMEOUT_S}


def test_from_env_reads_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    assert OpenAiLlmClient.from_env().client.api_key == "test-key"


def test_from_env_passes_on_call_through(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    calls: list[LlmCall] = []

    assert OpenAiLlmClient.from_env(on_call=calls.append).on_call == calls.append


def test_from_env_requires_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        OpenAiLlmClient.from_env()


# ----------------------------------------------------------------------
# Tests for what each call reports
# ----------------------------------------------------------------------


def test_reports_a_successful_calls_usage_with_its_cached_tokens() -> None:
    usage = CompletionUsage(
        prompt_tokens=1200,
        completion_tokens=7,
        total_tokens=1207,
        prompt_tokens_details=PromptTokensDetails(cached_tokens=1024),
    )
    client, _, _, calls = _reporting_client(_completion("cheddar", usage=usage))

    client.clean_product_name("cheddar")

    assert calls == [_call(input_tokens=1200, cached_input_tokens=1024, output_tokens=7)]


def test_reports_each_methods_operation() -> None:
    client, _, _, calls = _reporting_client("cheddar", "Cheese")

    client.clean_product_name("cheddar")
    client.match_product_to_category("cheddar", ["Cheese"])

    assert calls == [_call(operation="clean"), _call(operation="match")]


@pytest.mark.parametrize(
    ("failures", "rate_limited_requests"),
    [
        pytest.param([_status_error(429)] * 4, 4, id="four 429s"),
        pytest.param(
            [openai.APITimeoutError(request=_REQUEST), _status_error(500)], 0, id="timeout, 500"
        ),
    ],
)
def test_reports_the_failed_requests_before_a_success(
    failures: list[Exception], rate_limited_requests: int
) -> None:
    client, _, _, calls = _reporting_client(*failures, "cheddar")

    client.clean_product_name("cheddar")

    assert calls == [
        _call(
            requests=len(failures) + 1,
            failed_requests=len(failures),
            rate_limited_requests=rate_limited_requests,
        )
    ]


def test_reports_exhausted_retries_with_no_usage() -> None:
    client, _, _, calls = _reporting_client(*[_status_error(429)] * MAX_ATTEMPTS)

    with pytest.raises(UpstreamApiError):
        client.clean_product_name("cheddar")

    assert calls == [
        _call(
            served_model=None,
            requests=MAX_ATTEMPTS,
            failed_requests=MAX_ATTEMPTS,
            rate_limited_requests=MAX_ATTEMPTS,
            input_tokens=0,
            output_tokens=0,
        )
    ]


@pytest.mark.parametrize(
    "error",
    [
        pytest.param(_status_error(400), id="non-retryable status"),
        pytest.param(RuntimeError("bug"), id="not an API error"),
    ],
)
def test_reports_a_failure_that_is_not_retried(error: Exception) -> None:
    client, _, _, calls = _reporting_client(error)

    with pytest.raises(type(error)):
        client.match_product_to_category("cheddar", ["Cheese"])

    assert calls == [
        _call(
            operation="match",
            served_model=None,
            failed_requests=1,
            input_tokens=0,
            output_tokens=0,
        )
    ]


def test_reports_the_billed_tokens_of_an_empty_answer() -> None:
    client, _, _, calls = _reporting_client(None)

    with pytest.raises(ValueError, match="no content"):
        client.clean_product_name("cheddar")

    assert calls == [_call()]


def test_reports_an_answer_cut_off_at_max_tokens() -> None:
    client, _, _, calls = _reporting_client(_completion("cheddar che", finish_reason="length"))

    client.clean_product_name("cheddar")

    assert calls == [_call(truncated=True)]


@pytest.mark.parametrize(
    "usage",
    [
        pytest.param(None, id="no usage"),
        pytest.param(
            CompletionUsage(prompt_tokens=0, completion_tokens=0, total_tokens=0),
            id="no prompt details",
        ),
        pytest.param(
            CompletionUsage(
                prompt_tokens=0,
                completion_tokens=0,
                total_tokens=0,
                prompt_tokens_details=PromptTokensDetails(),
            ),
            id="no cached tokens",
        ),
    ],
)
def test_reports_missing_usage_as_zero(usage: CompletionUsage | None) -> None:
    client, _, _, calls = _reporting_client(_completion("cheddar", usage=usage))

    client.clean_product_name("cheddar")

    assert calls == [_call(input_tokens=0, output_tokens=0)]


# ----------------------------------------------------------------------
# Tests for pricing
# ----------------------------------------------------------------------


def test_refuses_an_unpriced_model() -> None:
    with pytest.raises(ValueError, match="'gpt-9' has no price"):
        OpenAiLlmClient(cast(openai.OpenAI, FakeOpenAi([])), model="gpt-9")


@pytest.mark.parametrize(
    ("input_tokens", "cached_input_tokens", "output_tokens", "expected"),
    [
        pytest.param(0, 0, 0, 0, id="nothing"),
        # 1M uncached at $0.40, 1M cached at $0.10, 1M output at $1.60.
        pytest.param(2_000_000, 1_000_000, 1_000_000, 2_100_000, id="cached discount"),
        # A cached token is 0.1 micro-USD, an input token 0.4, an output token 1.6.
        pytest.param(5, 5, 0, 1, id="exactly half rounds up"),
        pytest.param(1, 0, 0, 0, id="under half rounds down"),
        pytest.param(0, 0, 1, 2, id="over half rounds up"),
    ],
)
def test_cost_micro_usd(
    input_tokens: int, cached_input_tokens: int, output_tokens: int, expected: int
) -> None:
    assert (
        cost_micro_usd(
            "gpt-4.1-mini",
            input_tokens=input_tokens,
            cached_input_tokens=cached_input_tokens,
            output_tokens=output_tokens,
        )
        == expected
    )


@pytest.mark.parametrize(
    ("input_tokens", "cached_input_tokens", "output_tokens"),
    [
        pytest.param(10, 11, 0, id="more cached than input"),
        pytest.param(10, -1, 0, id="negative cached"),
        pytest.param(-1, 0, 0, id="negative input"),
        pytest.param(10, 0, -1, id="negative output"),
    ],
)
def test_cost_micro_usd_rejects_impossible_counts(
    input_tokens: int, cached_input_tokens: int, output_tokens: int
) -> None:
    with pytest.raises(ValueError, match="Impossible token counts"):
        cost_micro_usd(
            "gpt-4.1-mini",
            input_tokens=input_tokens,
            cached_input_tokens=cached_input_tokens,
            output_tokens=output_tokens,
        )
