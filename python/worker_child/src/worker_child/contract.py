"""The child's half of the run-directory contract, checked against `contract/contract.json`.

Not read from that file at runtime: hatchling ships only `src/worker_child/`, so an installed
wheel must not need the repo checkout.
"""

import re
from typing import Final, Literal, get_args

MODULE: Final = "worker_child"
POSITIONAL_ARGUMENTS: Final = ("runDirectory",)
WORKING_DIRECTORY: Final = "work"
SECRET_ENVIRONMENT_VARIABLES: Final = (
    "GEMINI_API_KEY",
    "LLM_WHISPERER_API_KEY",
    "OPENAI_API_KEY",
)

MANIFEST: Final = "input/run.json"
INPUT_CSV: Final = "input/input.csv"
PROGRESS: Final = "output/progress.json"
RESULT: Final = "output/result.json"
FAILURE: Final = "output/failure.json"
RESULT_FILES_DIRECTORY: Final = "output/files"
WORK_DIRECTORY: Final = "work"

DIRECTORIES_CREATED_BY_PARENT: Final = ("input", "output", "output/files", "work")

PDF_FILE_NAME: Final = "report.pdf"
XLSX_FILE_NAME: Final = "report.xlsx"

CHART_KEY_PATTERN: Final = re.compile(r"[a-z0-9]+(_[a-z0-9]+)*")


def chart_file_name(chart_key: str) -> str:
    return f"chart-{chart_key}.png"


EXIT_WROTE_RESULT: Final = 0
EXIT_WROTE_FAILURE: Final = 1

CountsBasis = Literal["people", "meals"]
UnitSystem = Literal["lb", "kg"]

COUNTS_BASES: Final[tuple[CountsBasis, ...]] = get_args(CountsBasis)
UNIT_SYSTEMS: Final[tuple[UnitSystem, ...]] = get_args(UnitSystem)

# A strict subset of `analysis_failure_reason`; the rest are verdicts only the parent can reach.
ChildFailureReason = Literal["contract_violation", "unknown", "upstream_api"]

CHILD_FAILURE_REASONS: Final[tuple[ChildFailureReason, ...]] = get_args(ChildFailureReason)
