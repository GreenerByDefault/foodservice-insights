"""Where every file lives in the run directory.

The diagram, and why the layout is shaped this way, live on the parent's half of this seam:
`apps/worker/src/contract/layout.ts`. This module is the Python copy of the same names.
"""

import re
from pathlib import Path
from typing import Final

from worker_child.contract import ContractError

MANIFEST: Final = "input/run.json"
INPUT_CSV: Final = "input/input.csv"
INPUT_CSV_COLUMNS: Final = ("product", "date", "weight")
INPUT_CSV_DATE_FORMAT: Final = "YYYY-MM-DD"
PROGRESS: Final = "output/progress.json"
RESULT: Final = "output/result.json"
FAILURE: Final = "output/failure.json"
RESULT_FILES_DIRECTORY: Final = "output/files"
WORK_DIRECTORY: Final = "work"

DIRECTORIES_CREATED_BY_PARENT: Final = ("input", "output", "output/files", "work")

PDF_FILE_NAME: Final = "report.pdf"
XLSX_FILE_NAME: Final = "report.xlsx"

CHART_KEY_PATTERN: Final = re.compile(r"[a-z0-9]+(_[a-z0-9]+)*")


def require_chart_key(chart_key: str) -> None:
    if not CHART_KEY_PATTERN.fullmatch(chart_key):
        raise ContractError(f"chart key '{chart_key}' is not snake_case")


def chart_file_name(chart_key: str) -> str:
    # The key becomes a path segment, so it is validated here rather than by each caller: the
    # pattern is what makes traversal impossible by construction.
    require_chart_key(chart_key)
    return f"chart-{chart_key}.png"


def require_created_by_parent(run_directory: Path) -> None:
    missing = [
        relative
        for relative in DIRECTORIES_CREATED_BY_PARENT
        if not (run_directory / relative).is_dir()
    ]
    if missing:
        raise ContractError(f"run directory is missing {', '.join(missing)}")
