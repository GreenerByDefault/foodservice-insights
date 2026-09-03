from gbd_foodservice_insights.analysis import (
    InvalidInputError,
    UnusableDataError,
    UpstreamApiError,
)

from worker_child.contract import ContractError
from worker_child.contract.names import ChildFailureReason


def classify_error(error: Exception) -> tuple[ChildFailureReason, str]:
    detail = str(error) or repr(error)
    if isinstance(error, UpstreamApiError):
        return "upstream_api", detail
    if isinstance(error, UnusableDataError):
        return "unusable_data", detail
    if isinstance(error, InvalidInputError | ContractError):
        return "contract_violation", detail
    return "unknown", detail
