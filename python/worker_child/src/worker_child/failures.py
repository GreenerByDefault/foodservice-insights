"""`classify(error) -> (reason, detail)`: pure and table-driven, exhaustive over the child's
closed set of failure reasons — kept that way by the parity test in `test_contract.py`
against `contract/contract.json`.
"""

from gbd_foodservice_insights.analysis import (
    InvalidInputError,
    UnusableDataError,
    UpstreamApiError,
)

from worker_child.contract import ChildFailureReason
from worker_child.parse import ContractError


def classify(error: Exception) -> tuple[ChildFailureReason, str]:
    detail = str(error) or repr(error)
    if isinstance(error, UpstreamApiError):
        return "upstream_api", detail
    if isinstance(error, UnusableDataError):
        return "unusable_data", detail
    if isinstance(error, InvalidInputError):
        # `input.csv` is not what the parent promised — a validation hole in `apps/web`, not
        # something a retry or a page to us would fix.
        return "contract_violation", detail
    if isinstance(error, ContractError):
        # Bad `run.json`, a bad chart key, a missing parent-created directory, or an
        # `AnalysisOutcome` that declared a file the library never wrote.
        return "contract_violation", detail
    return "unknown", detail
