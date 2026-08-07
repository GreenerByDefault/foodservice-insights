"""The child's half of the run-directory contract.

Every value here is duplicated in `apps/worker/src/contract/`, and `tests/test_contract.py`
asserts this half equals `contract/contract.json`. That is what makes renaming a path here
without renaming it there fail `just test` — the TypeScript jobs may never run, because
`.github/filters.yml` skips them for a Python-only change.

Deliberately not read from `contract/contract.json` at runtime: hatchling ships only what lives
under `src/worker_child/`, so an installed wheel must not need the repo checkout.

The layout itself, and why it is shaped this way, is documented on
`apps/worker/src/contract/layout.ts`. The parent owns it; this file only has to agree.
"""

import re
from typing import Final, Literal, get_args

CONTRACT_VERSION: Final = 1

# --- Invocation --------------------------------------------------------------------------

MODULE: Final = "worker_child"
POSITIONAL_ARGUMENTS: Final = ("runDirectory",)
WORKING_DIRECTORY: Final = "work"
SECRET_ENVIRONMENT_VARIABLES: Final = (
    "GEMINI_API_KEY",
    "LLM_WHISPERER_API_KEY",
    "OPENAI_API_KEY",
)

# --- Paths within a run directory --------------------------------------------------------

MANIFEST: Final = "input/run.json"
INPUT_CSV: Final = "input/input.csv"
PROGRESS: Final = "output/progress.json"
RESULT: Final = "output/result.json"
FAILURE: Final = "output/failure.json"
RESULT_FILES_DIRECTORY: Final = "output/files"
WORK_DIRECTORY: Final = "work"

# The parent creates these before spawning. The child creates none of them: a missing directory
# means the parent broke its own contract, and is worth failing loudly over.
DIRECTORIES_CREATED_BY_PARENT: Final = ("input", "output", "output/files", "work")

PDF_FILE_NAME: Final = "report.pdf"
XLSX_FILE_NAME: Final = "report.xlsx"

CHART_KEY_PATTERN: Final = re.compile(r"[a-z0-9]+(_[a-z0-9]+)*")


def chart_file_name(chart_key: str) -> str:
    """Charts are named from their key, so `result.json` never carries a path."""
    return f"chart-{chart_key}.png"


# --- Exit codes ---------------------------------------------------------------------------

# An exit code says only whether a verdict was reached, and which file holds it.
EXIT_WROTE_RESULT: Final = 0
EXIT_WROTE_FAILURE: Final = 1

# --- Database enums that cross the seam -----------------------------------------------------

# Spelled identically to the database enums of the same name, so the parent passes them through
# without translating. `contract/contract.json` is what holds the two sides to the same list.
CountsBasis = Literal["people", "meals"]
UnitSystem = Literal["lb", "kg"]

COUNTS_BASES: Final[tuple[CountsBasis, ...]] = get_args(CountsBasis)
UNIT_SYSTEMS: Final[tuple[UnitSystem, ...]] = get_args(UnitSystem)

# --- Failure reasons ------------------------------------------------------------------------

# A strict subset of the database's `analysis_failure_reason`, spelled identically so the parent
# validates and passes the value straight through. The reasons missing from this list —
# `child_crashed`, `hung`, `hard_timeout`, `infrastructure` — are verdicts only the parent can
# reach, and a child claiming one is not believed.
ChildFailureReason = Literal["contract_violation", "unknown", "upstream_api"]

CHILD_FAILURE_REASONS: Final[tuple[ChildFailureReason, ...]] = get_args(ChildFailureReason)
