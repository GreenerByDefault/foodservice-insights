from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, cast

import anthropic
import httpx2
import pytest
from anthropic.types import (
    ContentBlock,
    Message,
    RefusalStopDetails,
    StopReason,
    TextBlock,
    ThinkingBlock,
    Usage,
)
from gbd_foodservice_insights.categorization.llm import (
    MAX_ATTEMPTS,
    MODELS,
    REQUEST_TIMEOUT_S,
    AnthropicLlmClient,
    LlmCall,
    cost_micro_usd,
)
from gbd_foodservice_insights.errors import UpstreamApiError

_REQUEST = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


def _status_error(status_code: int) -> anthropic.APIStatusError:
    # The SDK's own mapping from a status code to its exception class, so a 429 is a
    # `RateLimitError` exactly as it would be in production.
    response = httpx2.Response(status_code, request=_REQUEST)
    return anthropic.Anthropic(api_key="unused")._make_status_error_from_response(response)


MODEL = "claude-sonnet-5-5"
DEFAULT_USAGE = Usage(input_tokens=1000, output_tokens=5)


def _message(
    *content: ContentBlock,
    usage: Usage = DEFAULT_USAGE,
    stop_reason: StopReason = "end_turn",
    stop_details: RefusalStopDetails | None = None,
) -> Message:
    return Message(
        id="msg_test",
        type="message",
        role="assistant",
        model=MODEL,
        content=list(content),
        stop_reason=stop_reason,
        stop_details=stop_details,
        stop_sequence=None,
        usage=usage,
    )


def _text(text: str) -> TextBlock:
    return TextBlock(type="text", text=text)


# A bare string is shorthand for a message with that text and `DEFAULT_USAGE`.
type Outcome = Exception | Message | str


@dataclass
class FakeAnthropic:
    """Stands in for `anthropic.Anthropic`: each `create` call pops the next scripted outcome."""

    outcomes: list[Outcome]
    requests: list[dict[str, Any]] = field(default_factory=list)
    options: dict[str, Any] = field(default_factory=dict)

    def with_options(self, **options: Any) -> FakeAnthropic:
        self.options = options
        return self

    @property
    def messages(self) -> Any:
        return SimpleNamespace(create=self._create)

    def _create(self, **kwargs: Any) -> Message:
        self.requests.append(kwargs)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome if isinstance(outcome, Message) else _message(_text(outcome))


def _client(*outcomes: Outcome) -> tuple[AnthropicLlmClient, FakeAnthropic, list[float]]:
    client, fake, sleeps, _ = _reporting_client(*outcomes)
    return client, fake, sleeps


def _reporting_client(
    *outcomes: Outcome, model: str = MODEL
) -> tuple[AnthropicLlmClient, FakeAnthropic, list[float], list[LlmCall]]:
    fake = FakeAnthropic(list(outcomes))
    sleeps: list[float] = []
    calls: list[LlmCall] = []
    client = AnthropicLlmClient(
        cast(anthropic.Anthropic, fake), model=model, sleep=sleeps.append, on_call=calls.append
    )
    return client, fake, sleeps, calls


def _call(**overrides: Any) -> LlmCall:
    """The `LlmCall` for one `clean` request answered with `DEFAULT_USAGE`, with `overrides`."""
    defaults: dict[str, Any] = {
        "operation": "clean",
        "requested_model": MODEL,
        "served_model": MODEL,
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
        anthropic.APIConnectionError(request=_REQUEST),
        anthropic.APITimeoutError(request=_REQUEST),
        _status_error(529),
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

    with pytest.raises(anthropic.APIStatusError) as excinfo:
        client.match_product_to_category("chese", ["Cheese"])

    assert not isinstance(excinfo.value, UpstreamApiError)
    assert excinfo.value.status_code == status_code
    assert len(fake.requests) == 1
    assert sleeps == []


def test_an_answer_without_text_is_an_error() -> None:
    client, _, _ = _client(_message())

    with pytest.raises(ValueError, match="no text"):
        client.clean_product_name("cheddar")


def test_a_refusal_is_an_error_naming_its_category() -> None:
    refusal = _message(
        stop_reason="refusal",
        stop_details=RefusalStopDetails(type="refusal", category="general_harms"),
    )
    client, _, _ = _client(refusal)

    with pytest.raises(ValueError, match=r"refused.*general_harms"):
        client.match_product_to_category("cheddar", ["Cheese"])


def test_reads_the_text_after_a_thinking_block() -> None:
    client, _, _ = _client(
        _message(ThinkingBlock(type="thinking", thinking="", signature="sig"), _text("Cheese"))
    )

    assert client.match_product_to_category("cheddar", ["Cheese"]) == "Cheese"


def test_clean_product_name_strips_pack_counts_and_lowercases() -> None:
    client, fake, _ = _client("Cheddar Cheese")

    assert client.clean_product_name("CHEDDAR (12) .5 2.5 5.LB") == "cheddar cheese"
    assert fake.requests[0]["messages"] == [
        {"role": "user", "content": "classify CHEDDAR  .5 2.5 5LB according to your instructions"}
    ]


def test_match_prompt_lists_the_categories() -> None:
    client, fake, _ = _client("Cheese")

    client.match_product_to_category("cheddar", ["Cheese", "Butter"])

    [system] = fake.requests[0]["system"]
    assert "\nCheese\nButter\n" in system["text"]
    assert 'say "None"' not in system["text"]
    assert "No Matches Found" in system["text"]


def test_the_system_prompt_is_cached() -> None:
    client, fake, _ = _client("cheddar")

    client.clean_product_name("cheddar")

    [system] = fake.requests[0]["system"]
    assert system["cache_control"] == {"type": "ephemeral"}


@pytest.mark.parametrize(
    ("model", "thinking"),
    [
        pytest.param("claude-haiku-5-5", {"type": "disabled"}, id="haiku"),
        pytest.param("claude-sonnet-5-5", {"type": "between_tools"}, id="sonnet"),
        pytest.param("claude-opus-5-5", anthropic.omit, id="opus"),
    ],
)
def test_each_model_is_asked_to_think_as_little_as_it_can(model: str, thinking: object) -> None:
    client, fake, _, _ = _reporting_client("cheddar", model=model)

    client.clean_product_name("cheddar")

    request = fake.requests[0]
    assert request["model"] == model
    assert request["thinking"] == thinking
    assert request["output_config"] == {"effort": "low"}
    assert request["max_tokens"] == MODELS[model].max_tokens
    assert "temperature" not in request


def test_match_returns_the_models_text_untouched() -> None:
    client, _, _ = _client('"Cheese."')

    assert client.match_product_to_category("cheddar", ["Cheese"]) == '"Cheese."'


def test_requests_go_out_with_sdk_retries_off() -> None:
    client, fake, _ = _client("Cheese")

    client.clean_product_name("cheddar")

    assert fake.options == {"max_retries": 0, "timeout": REQUEST_TIMEOUT_S}


def test_from_env_reads_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    assert AnthropicLlmClient.from_env().client.api_key == "test-key"


def test_from_env_passes_on_call_through(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    calls: list[LlmCall] = []

    assert AnthropicLlmClient.from_env(on_call=calls.append).on_call == calls.append


def test_from_env_requires_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    with pytest.raises(ValueError, match="ANTHROPIC_API_KEY"):
        AnthropicLlmClient.from_env()


# ----------------------------------------------------------------------
# Tests for what each call reports
# ----------------------------------------------------------------------


def test_reports_input_tokens_including_cache_reads_and_writes() -> None:
    usage = Usage(
        input_tokens=20,
        cache_read_input_tokens=1300,
        cache_creation_input_tokens=50,
        output_tokens=7,
    )
    client, _, _, calls = _reporting_client(_message(_text("cheddar"), usage=usage))

    client.clean_product_name("cheddar")

    assert calls == [_call(input_tokens=1370, cached_input_tokens=1300, output_tokens=7)]


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
            [anthropic.APITimeoutError(request=_REQUEST), _status_error(500)], 0, id="timeout, 500"
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


def test_reports_the_billed_tokens_of_a_refusal() -> None:
    client, _, _, calls = _reporting_client(_message(stop_reason="refusal"))

    with pytest.raises(ValueError, match="refused"):
        client.clean_product_name("cheddar")

    assert calls == [_call()]


def test_reports_an_answer_cut_off_at_max_tokens() -> None:
    client, _, _, calls = _reporting_client(
        _message(_text("cheddar che"), stop_reason="max_tokens")
    )

    client.clean_product_name("cheddar")

    assert calls == [_call(truncated=True)]


def test_reports_absent_cache_counts_as_zero() -> None:
    usage = Usage(
        input_tokens=1000,
        cache_read_input_tokens=None,
        cache_creation_input_tokens=None,
        output_tokens=5,
    )
    client, _, _, calls = _reporting_client(_message(_text("cheddar"), usage=usage))

    client.clean_product_name("cheddar")

    assert calls == [_call()]


# ----------------------------------------------------------------------
# Tests for pricing
# ----------------------------------------------------------------------


def test_refuses_a_model_without_settings() -> None:
    with pytest.raises(ValueError, match="'claude-9' has no settings"):
        AnthropicLlmClient(cast(anthropic.Anthropic, FakeAnthropic([])), model="claude-9")


@pytest.mark.parametrize(
    ("input_tokens", "cached_input_tokens", "output_tokens", "expected"),
    [
        pytest.param(0, 0, 0, 0, id="nothing"),
        # 1M uncached at $2, 1M cached at $0.10, 1M output at $10.
        pytest.param(2_000_000, 1_000_000, 1_000_000, 12_100_000, id="cached discount"),
        # A cached token is 0.1 micro-USD, an input token 2, an output token 10.
        pytest.param(5, 5, 0, 1, id="exactly half rounds up"),
        pytest.param(4, 4, 0, 0, id="under half rounds down"),
    ],
)
def test_cost_micro_usd(
    input_tokens: int, cached_input_tokens: int, output_tokens: int, expected: int
) -> None:
    assert (
        cost_micro_usd(
            MODEL,
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
            MODEL,
            input_tokens=input_tokens,
            cached_input_tokens=cached_input_tokens,
            output_tokens=output_tokens,
        )
