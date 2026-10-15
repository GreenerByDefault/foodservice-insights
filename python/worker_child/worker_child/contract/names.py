"""The vocabularies the parent and child must spell identically."""

from typing import Final, Literal, get_args

MODULE: Final = "worker_child"
POSITIONAL_ARGUMENTS: Final = ("runDirectory",)
WORKING_DIRECTORY: Final = "work"
ENVIRONMENT_VARIABLES: Final = ("PATH", "HOME", "LANG", "TZ", "OPENAI_API_KEY")

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

# A strict subset of `analysis_failure_reason`; the rest are verdicts only the parent can reach.
ChildFailureReason = Literal["contract_violation", "unknown", "upstream_api", "unusable_data"]

CHILD_FAILURE_REASONS: Final[tuple[ChildFailureReason, ...]] = get_args(ChildFailureReason)
