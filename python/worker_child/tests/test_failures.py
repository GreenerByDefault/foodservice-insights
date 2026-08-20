import pytest
from gbd_foodservice_insights.analysis import (
    InvalidInputError,
    UnusableDataError,
    UpstreamApiError,
)
from worker_child.contract.fields import ContractError
from worker_child.contract.names import CHILD_FAILURE_REASONS
from worker_child.failures import classify_error


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (UpstreamApiError("rate limited"), "upstream_api"),
        (UnusableDataError("nothing to report"), "unusable_data"),
        (InvalidInputError("weight is not a number"), "contract_violation"),
        (ContractError("run.json: not valid JSON"), "contract_violation"),
        (RuntimeError("anything else"), "unknown"),
        (ValueError(), "unknown"),
    ],
)
def test_classifies_each_error_type(error: Exception, reason: str) -> None:
    assert classify_error(error)[0] == reason


def test_preserves_the_error_message_as_the_detail() -> None:
    reason, detail = classify_error(UpstreamApiError("Gemini returned 429"))
    assert reason == "upstream_api"
    assert detail == "Gemini returned 429"


def test_falls_back_to_repr_when_the_error_has_no_message() -> None:
    _, detail = classify_error(ValueError())
    assert detail  # `failure_payload` requires a non-empty detail


def test_every_reason_classify_error_can_produce_is_one_the_child_may_claim() -> None:
    producible = {
        classify_error(error)[0]
        for error in (
            UpstreamApiError("x"),
            UnusableDataError("x"),
            InvalidInputError("x"),
            ContractError("x"),
            RuntimeError("x"),
        )
    }
    assert producible == set(CHILD_FAILURE_REASONS)
