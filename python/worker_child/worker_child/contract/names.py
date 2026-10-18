"""The vocabularies the parent and child must spell identically."""

from typing import Final, Literal, get_args

MODULE: Final = "worker_child"
POSITIONAL_ARGUMENTS: Final = ("runDirectory",)
WORKING_DIRECTORY: Final = "work"
ENVIRONMENT_VARIABLES: Final = ("PATH", "HOME", "LANG", "TZ", "OPENAI_API_KEY")

# `MAX_CACHE_KEY_BYTES` in `@gbd/db`, the bound the cache tables' CHECKs enforce, in UTF-8.
MAX_PRODUCT_BYTES: Final = 2000

EXIT_WROTE_RESULT: Final = 0
EXIT_WROTE_FAILURE: Final = 1
EXIT_USAGE_ERROR: Final = 2

CountsBasis = Literal["people", "meals"]
UnitSystem = Literal["lb", "kg"]

COUNTS_BASES: Final[tuple[CountsBasis, ...]] = get_args(CountsBasis)
UNIT_SYSTEMS: Final[tuple[UnitSystem, ...]] = get_args(UnitSystem)

LlmOperation = Literal["clean", "match"]
# In the order they run, which is the order `telemetry.json`'s `stageDurationMs` fills in.
Stage = Literal["read", "categorize", "report", "pdf", "xlsx"]
QualityCheck = Literal[
    "outlier_line_items",
    "per_product_weight_bounds",
    "month_over_month_total_volatility",
    "diner_meal_count_reasonableness",
    "missing_internal_months",
    "date_distribution",
]
DiagnosticStatus = Literal["success", "info", "warning", "error"]

LLM_OPERATIONS: Final[tuple[LlmOperation, ...]] = get_args(LlmOperation)
STAGES: Final[tuple[Stage, ...]] = get_args(Stage)
QUALITY_CHECKS: Final[tuple[QualityCheck, ...]] = get_args(QualityCheck)
DIAGNOSTIC_STATUSES: Final[tuple[DiagnosticStatus, ...]] = get_args(DiagnosticStatus)

# The statuses the customer's PDF lists, `analysis_attempt_finding_status_is_warning_or_error`.
CustomerFindingStatus = Literal["warning", "error"]
CUSTOMER_FINDING_STATUSES: Final[tuple[CustomerFindingStatus, ...]] = get_args(
    CustomerFindingStatus
)
# `analysis_attempt_finding_sample_values_at_most_5`.
MAX_FINDING_SAMPLE_VALUES: Final = 5
# `MAX_FINDING_TEXT_BYTES` in `apps/worker`, where the reasoning behind it lives.
MAX_FINDING_TEXT_BYTES: Final = 4 * MAX_PRODUCT_BYTES

# A strict subset of `analysis_failure_reason`; the rest are verdicts only the parent can reach.
ChildFailureReason = Literal["contract_violation", "unknown", "upstream_api", "unusable_data"]

CHILD_FAILURE_REASONS: Final[tuple[ChildFailureReason, ...]] = get_args(ChildFailureReason)
