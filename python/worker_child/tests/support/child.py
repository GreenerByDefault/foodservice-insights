"""A real `python -m worker_child`-shaped process, driven by a JSON scenario in argv.

The mirror image of `apps/worker/src/testing/fake-child.ts`, including its reasoning for
putting the scenario in argv rather than the environment: the seam cannot be widened to make
testing easier. Every scenario knob names an *outcome of the seam* — what `analyze()` returns,
raises, or does before returning — never an internal of the (still unported) library. That is
exactly why this infrastructure survives the port landing.

    python tests/support/child.py '<scenario-json>' <runDirectory>

Builds an `analyze` from `gbd_foodservice_insights.testing.stub_analysis` and calls the real
`worker_child.run.run(run_directory, analyze=...)`, so everything downstream — `run.py`,
`failures.py`, `artifacts.py`, `writer.py` — runs for real, as a real OS process.
"""

import json
import os
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

from gbd_foodservice_insights.analysis import (
    AnalysisOutcome,
    AnalysisRequest,
    InvalidInputError,
    ReportProgress,
    UnusableDataError,
    UpstreamApiError,
)
from gbd_foodservice_insights.testing import DEFAULT_CHART_KEYS, stub_analysis
from worker_child.contract import layout
from worker_child.run import Analyze, run
from worker_child.writer import dump_json, write_atomically

# Where the OS-level facts a scenario asks for get recorded — always beneath `work/`, the
# child's own scratch directory, so this can never collide with anything the contract defines.
DEBUG_FILES = {
    "cwd": "cwd.txt",
    "environment": "environment.json",
    "grandchild_pid": "grandchild.pid",
}

# How often a hung analysis checks in. Only ever observed by a test that has already sent a
# kill signal; the process never reaches the other side of the loop on its own.
HANG_TICK_SECONDS = 1

RAISES_BY_NAME: dict[str, type[Exception]] = {
    "upstream": UpstreamApiError,
    "invalid_input": InvalidInputError,
    "unusable_data": UnusableDataError,
    # Anything that is not an `AnalysisError` maps to `unknown`; `RuntimeError` stands in for it.
    "other": RuntimeError,
}


@dataclass(frozen=True)
class Scenario:
    charts: tuple[str, ...] = DEFAULT_CHART_KEYS
    without_files: frozenset[str] = field(default_factory=frozenset)
    cost_usd: Decimal = Decimal("0.5")
    progress_calls: int = 2
    raises: type[Exception] | None = None
    hang: bool = False
    ignore_sigterm: bool = False
    spawn_grandchild: bool = False


def parse_scenario(data: Mapping[str, Any]) -> Scenario:
    raises_name = data.get("raises")
    return Scenario(
        charts=tuple(data.get("charts", DEFAULT_CHART_KEYS)),
        without_files=frozenset(data.get("withoutFiles", ())),
        cost_usd=Decimal(str(data["costUsd"])) if "costUsd" in data else Decimal("0.5"),
        progress_calls=data.get("progressCalls", 2),
        raises=RAISES_BY_NAME[raises_name] if raises_name is not None else None,
        hang=data.get("hang", False),
        ignore_sigterm=data.get("ignoreSigterm", False),
        spawn_grandchild=data.get("spawnGrandchild", False),
    )


def build_analyze(scenario: Scenario) -> Analyze:
    def analyze(
        request: AnalysisRequest, *, report_progress: ReportProgress = lambda: None
    ) -> AnalysisOutcome:
        _dump_debug_files(request.work_directory)
        if scenario.ignore_sigterm:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if scenario.spawn_grandchild:
            _spawn_grandchild(request.work_directory)
        _report_progress_under_load(report_progress, scenario.progress_calls)

        if scenario.hang:
            while True:
                time.sleep(HANG_TICK_SECONDS)

        if scenario.raises is not None:
            message = f"tests/support/child.py: raising {scenario.raises.__name__} on request"
            raise scenario.raises(message)

        return stub_analysis(
            request,
            chart_keys=scenario.charts,
            write_pdf=layout.PDF_FILE_NAME not in scenario.without_files,
            write_xlsx=layout.XLSX_FILE_NAME not in scenario.without_files,
            charts_to_write=[
                key
                for key in scenario.charts
                if layout.chart_file_name(key) not in scenario.without_files
            ],
            cost_usd=scenario.cost_usd,
            progress_calls=0,  # already reported above
        )

    return analyze


def _dump_debug_files(work_directory: Path) -> None:
    write_atomically(work_directory / DEBUG_FILES["cwd"], os.getcwd().encode())
    write_atomically(work_directory / DEBUG_FILES["environment"], dump_json(dict(os.environ)))


def _report_progress_under_load(report_progress: ReportProgress, count: int) -> None:
    """Calls `report_progress` from `count` concurrent threads: proof that the writer's
    atomicity — already covered in-process in `test_writer.py` — holds under a real OS
    scheduler too, not just `ThreadPoolExecutor` inside one pytest worker.
    """
    threads = [threading.Thread(target=report_progress) for _ in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()


def _spawn_grandchild(work_directory: Path) -> None:
    """Stands in for a subprocess the analysis library spawns, so a test can check that a kill
    aimed at this process reaches it too. Not `start_new_session`: staying in this process's
    group is what that kill relies on.
    """
    grandchild = subprocess.Popen(
        [sys.executable, "-c", "import time\nwhile True:\n    time.sleep(1)"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    write_atomically(work_directory / DEBUG_FILES["grandchild_pid"], str(grandchild.pid).encode())


def main(argv: list[str]) -> int:
    scenario_json, run_directory = argv[1], argv[2]
    scenario = parse_scenario(json.loads(scenario_json))
    return run(Path(run_directory), analyze=build_analyze(scenario))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
