from gbd_foodservice_insights.analysis import (
    InvalidInputError,
    UnusableDataError,
    UpstreamApiError,
)

from worker_child.contract import ChildFailureReason
from worker_child.parse import ContractError


def classify(error: Exception) -> tuple[ChildFailureReason, str]:
    """Pure and table-driven, exhaustive over the child's closed set of failure reasons —
    kept that way by the parity test in `test_contract.py` against `contract/contract.json`.
    """
    detail = str(error) or repr(error)
    if isinstance(error, UpstreamApiError):
        return "upstream_api", detail
    if isinstance(error, UnusableDataError):
        return "unusable_data", detail
    if isinstance(error, InvalidInputError):
        return "contract_violation", detail
    if isinstance(error, ContractError):
        return "contract_violation", detail
    return "unknown", detail
