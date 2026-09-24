from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, cast

import httpx
import openai
import pytest
from gbd_foodservice_insights.categorization.llm import (
    MAX_ATTEMPTS,
    REQUEST_TIMEOUT_S,
    OpenAiLlmClient,
)
from gbd_foodservice_insights.errors import UpstreamApiError

_REQUEST = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")


def _status_error(status_code: int) -> openai.APIStatusError:
    # The SDK's own mapping from a status code to its exception class, so a 429 is a
    # `RateLimitError` exactly as it would be in production.
    response = httpx.Response(status_code, request=_REQUEST)
    return openai.OpenAI(api_key="unused")._make_status_error_from_response(response)


def _completion(content: str | None) -> Any:
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


@dataclass
class FakeOpenAi:
    """Stands in for `openai.OpenAI`: each `create` call pops the next scripted outcome."""

    outcomes: list[Exception | str | None]
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
        return _completion(outcome)


def _client(*outcomes: Exception | str | None) -> tuple[OpenAiLlmClient, FakeOpenAi, list[float]]:
    fake = FakeOpenAi(list(outcomes))
    sleeps: list[float] = []
    client = OpenAiLlmClient(cast(openai.OpenAI, fake), sleep=sleeps.append)
    return client, fake, sleeps


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
        client.fuzzy_match_category("chese", ["Cheese"])

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

    assert client.clean_product_name("CHEDDAR (12) 5.LB") == "cheddar cheese"
    messages = fake.requests[0]["messages"]
    assert messages[1] == {
        "role": "user",
        "content": "classify CHEDDAR  5LB according to your instructions",
    }


def test_category_prompts_list_the_categories() -> None:
    client, fake, _ = _client("Cheese", "Butter")

    client.match_product_to_category("cheddar", ["Cheese", "Butter"])
    client.fuzzy_match_category("buter", ["Cheese", "Butter"])

    for request in fake.requests:
        assert "['Cheese', 'Butter']" in request["messages"][0]["content"]


def test_requests_go_out_with_sdk_retries_off() -> None:
    client, fake, _ = _client("Cheese")

    client.clean_product_name("cheddar")

    assert fake.options == {"max_retries": 0, "timeout": REQUEST_TIMEOUT_S}


def test_from_env_reads_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    assert OpenAiLlmClient.from_env().client.api_key == "test-key"


def test_from_env_requires_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        OpenAiLlmClient.from_env()
