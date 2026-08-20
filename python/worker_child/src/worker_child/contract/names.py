"""The vocabularies the parent and child must spell identically."""

from typing import Final, Literal, get_args

MODULE: Final = "worker_child"
POSITIONAL_ARGUMENTS: Final = ("runDirectory",)
WORKING_DIRECTORY: Final = "work"
SECRET_ENVIRONMENT_VARIABLES: Final = (
    "GEMINI_API_KEY",
    "LLM_WHISPERER_API_KEY",
    "OPENAI_API_KEY",
)

EXIT_WROTE_RESULT: Final = 0
EXIT_WROTE_FAILURE: Final = 1
EXIT_USAGE_ERROR: Final = 2

CountsBasis = Literal["people", "meals"]
UnitSystem = Literal["lb", "kg"]

COUNTS_BASES: Final[tuple[CountsBasis, ...]] = get_args(CountsBasis)
UNIT_SYSTEMS: Final[tuple[UnitSystem, ...]] = get_args(UnitSystem)

# A strict subset of `analysis_failure_reason`; the rest are verdicts only the parent can reach.
ChildFailureReason = Literal["contract_violation", "unknown", "upstream_api", "unusable_data"]

CHILD_FAILURE_REASONS: Final[tuple[ChildFailureReason, ...]] = get_args(ChildFailureReason)
