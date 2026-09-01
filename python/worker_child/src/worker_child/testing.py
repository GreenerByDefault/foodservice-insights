"""The scenario catalogue a dev drives `pnpm dev` with, steered entirely by
`AnalysisRequest.report_name`.

Grammar: `!<scenario>` or `!<scenario>:<argument>`. A name not starting with `!` is the happy
path. An unrecognised `!name` raises, so `failure.json` names the valid scenarios back at you.

Ships in the wheel as `gbd_foodservice_insights/testing.py` does, so `worker_child`'s own
product code is banned from importing it (`tool.ruff.lint.flake8-tidy-imports.banned-api` in
the root `pyproject.toml`) while another package's `testing.py` — this one — may.

    python -m worker_child.testing <runDirectory>
"""

import logging
import math
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from gbd_foodservice_insights.analysis import (
    AnalysisError,
    AnalysisOutcome,
    AnalysisRequest,
    InvalidInputError,
    ReportProgress,
    UnusableDataError,
    UpstreamApiError,
)
from gbd_foodservice_insights.testing import stub_analysis

from worker_child.contract import names
from worker_child.run import Analyze, run

SCENARIO_PREFIX: Final = "!"

# How long `!slow` runs by default, and how often it reports progress while doing so.
SLOW_DEFAULT_SECONDS: Final = 60
SLOW_TICK_SECONDS: Final = 3

# How often `!hang` checks in before it goes quiet forever.
HANG_TICK_SECONDS: Final = 1

FAIL_REASONS: Final = {
    "upstream-api": UpstreamApiError,
    "unusable-data": UnusableDataError,
    "invalid-input": InvalidInputError,
}

KNOWN_SCENARIOS: Final = ("slow", "hang", "crash", "fail", "missing-pdf")

USAGE: Final = f"usage: python -m {__name__} <{'> <'.join(names.POSITIONAL_ARGUMENTS)}>"


@dataclass(frozen=True)
class Scenario:
    """A parsed `!<scenario>:<argument>`. `name=None` is the happy path — no `!` at all."""

    name: str | None
    argument: str | None = None


def parse_scenario(report_name: str | None) -> Scenario:
    if report_name is None or not report_name.startswith(SCENARIO_PREFIX):
        return Scenario(name=None)

    body = report_name.removeprefix(SCENARIO_PREFIX)
    name, _, argument = body.partition(":")
    if name not in KNOWN_SCENARIOS:
        raise ValueError(
            f"unknown scenario {name!r}; valid scenarios are: {', '.join(KNOWN_SCENARIOS)}"
        )
    return Scenario(name, argument or None)


def _no_op_progress() -> None:
    pass


def build_analyze(*, sleep: Callable[[float], None] = time.sleep) -> Analyze:
    """The `analyze` every `WORKER_MODE=stubbed` run injects. `sleep` is overridable so a test
    can drive `!slow` without waiting out real seconds; production never passes it.
    """

    def analyze(
        request: AnalysisRequest, *, report_progress: ReportProgress = _no_op_progress
    ) -> AnalysisOutcome:
        scenario = parse_scenario(request.report_name)

        if scenario.name is None:
            return stub_analysis(request, report_progress=report_progress)
        if scenario.name == "slow":
            return _run_slow(request, scenario.argument, report_progress, sleep)
        if scenario.name == "hang":
            report_progress()
            while True:
                sleep(HANG_TICK_SECONDS)
        if scenario.name == "crash":
            raise RuntimeError(f"worker_child.testing: !crash on {request.report_name!r}")
        if scenario.name == "fail":
            return stub_analysis(
                request,
                report_progress=report_progress,
                raises=_parse_fail_reason(scenario.argument),
            )
        if scenario.name == "missing-pdf":
            return stub_analysis(request, report_progress=report_progress, write_pdf=False)

        raise AssertionError(f"unreachable: parse_scenario already validated {scenario.name!r}")

    return analyze


def _run_slow(
    request: AnalysisRequest,
    argument: str | None,
    report_progress: ReportProgress,
    sleep: Callable[[float], None],
) -> AnalysisOutcome:
    duration = _parse_slow_duration(argument)
    ticks = math.ceil(duration / SLOW_TICK_SECONDS)
    for _ in range(ticks):
        report_progress()
        sleep(SLOW_TICK_SECONDS)
    return stub_analysis(request, progress_calls=0)


def _parse_slow_duration(argument: str | None) -> int:
    if argument is None:
        return SLOW_DEFAULT_SECONDS
    try:
        duration = int(argument)
    except ValueError:
        raise ValueError(f"!slow:{argument} — argument must be a whole number of seconds") from None
    if duration <= 0:
        raise ValueError(f"!slow:{argument} — argument must be positive")
    return duration


def _parse_fail_reason(argument: str | None) -> type[AnalysisError]:
    if argument not in FAIL_REASONS:
        raise ValueError(f"!fail:{argument} — reason must be one of: {', '.join(FAIL_REASONS)}")
    return FAIL_REASONS[argument]


def main(argv: list[str]) -> int:
    """`python -m worker_child.testing <runDirectory>` — the same contract as
    `python -m worker_child`, with `stub_analysis`'s scenarios wired in instead of the real
    library. `run.py` and `__main__.py` are untouched; this is a second entrypoint alongside
    them.
    """
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    if len(argv) != 2:
        print(USAGE, file=sys.stderr)
        return names.EXIT_USAGE_ERROR
    return run(Path(argv[1]), analyze=build_analyze())


if __name__ == "__main__":
    sys.exit(main(sys.argv))
