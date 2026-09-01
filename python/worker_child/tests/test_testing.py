import math
import threading
from pathlib import Path

import pytest
from gbd_foodservice_insights.analysis import (
    AnalysisError,
    AnalysisRequest,
    InvalidInputError,
    UnusableDataError,
    UpstreamApiError,
)
from worker_child.contract import layout, names
from worker_child.testing import (
    HANG_TICK_SECONDS,
    KNOWN_SCENARIOS,
    SLOW_DEFAULT_SECONDS,
    SLOW_TICK_SECONDS,
    Scenario,
    build_analyze,
    main,
    parse_scenario,
)


def _request(tmp_path: Path, report_name: str | None) -> AnalysisRequest:
    return AnalysisRequest(
        run_id="test-run",
        input_csv=tmp_path / "input.csv",
        output_directory=tmp_path,
        work_directory=tmp_path,
        report_name=report_name,
        site_name=None,
        counts_basis="people",
        unit_system="lb",
        monthly_counts={"2025-01": 100},
    )


# ----------------------------------------------------------------------------------------------
# the grammar
# ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize("report_name", [None, "Q1 2026 dining"])
def test_a_name_not_starting_with_bang_is_the_happy_path(report_name: str | None) -> None:
    assert parse_scenario(report_name) == Scenario(name=None)


def test_a_bare_scenario_name_has_no_argument() -> None:
    assert parse_scenario("!hang") == Scenario(name="hang", argument=None)


def test_a_scenario_with_an_argument_splits_on_the_first_colon() -> None:
    assert parse_scenario("!fail:unusable-data") == Scenario(name="fail", argument="unusable-data")


def test_an_empty_argument_after_the_colon_is_none() -> None:
    assert parse_scenario("!slow:") == Scenario(name="slow", argument=None)


def test_an_unknown_scenario_name_raises_and_names_the_valid_ones() -> None:
    with pytest.raises(ValueError, match="unknown scenario 'bogus'") as excinfo:
        parse_scenario("!bogus")
    for scenario in KNOWN_SCENARIOS:
        assert scenario in str(excinfo.value)


# ----------------------------------------------------------------------------------------------
# the happy path
# ----------------------------------------------------------------------------------------------


def test_the_happy_path_reports_progress_twice_and_writes_both_files(tmp_path: Path) -> None:
    calls = 0

    def count() -> None:
        nonlocal calls
        calls += 1

    outcome = build_analyze()(_request(tmp_path, "Q1 2026 dining"), report_progress=count)

    assert calls == 2
    assert outcome.pdf.exists()
    assert outcome.xlsx.exists()


# ----------------------------------------------------------------------------------------------
# !slow
# ----------------------------------------------------------------------------------------------


def test_slow_defaults_to_sixty_seconds(tmp_path: Path) -> None:
    ticks: list[float] = []

    build_analyze(sleep=ticks.append)(_request(tmp_path, "!slow"), report_progress=lambda: None)

    assert len(ticks) == math.ceil(SLOW_DEFAULT_SECONDS / SLOW_TICK_SECONDS)
    assert all(tick == SLOW_TICK_SECONDS for tick in ticks)


def test_slow_with_an_argument_reports_progress_every_tick_then_succeeds(tmp_path: Path) -> None:
    calls = 0

    def count() -> None:
        nonlocal calls
        calls += 1

    outcome = build_analyze(sleep=lambda _seconds: None)(
        _request(tmp_path, "!slow:8"), report_progress=count
    )

    assert calls == math.ceil(8 / SLOW_TICK_SECONDS)
    assert outcome.pdf.exists()


def test_slow_rejects_a_non_numeric_argument(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="whole number of seconds"):
        build_analyze()(_request(tmp_path, "!slow:soon"), report_progress=lambda: None)


def test_slow_rejects_a_non_positive_argument(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="must be positive"):
        build_analyze()(_request(tmp_path, "!slow:0"), report_progress=lambda: None)


# ----------------------------------------------------------------------------------------------
# !hang
# ----------------------------------------------------------------------------------------------


def test_hang_reports_progress_once_and_then_never_returns(tmp_path: Path) -> None:
    calls = 0

    def count() -> None:
        nonlocal calls
        calls += 1

    thread = threading.Thread(
        target=build_analyze(),
        args=(_request(tmp_path, "!hang"),),
        kwargs={"report_progress": count},
        daemon=True,
    )
    thread.start()
    thread.join(timeout=HANG_TICK_SECONDS * 2)

    assert thread.is_alive()
    assert calls == 1


# ----------------------------------------------------------------------------------------------
# !crash
# ----------------------------------------------------------------------------------------------


def test_crash_raises_a_bare_runtime_error(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="!crash"):
        build_analyze()(_request(tmp_path, "!crash"), report_progress=lambda: None)


# ----------------------------------------------------------------------------------------------
# !fail
# ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("reason", "error"),
    [
        ("upstream-api", UpstreamApiError),
        ("unusable-data", UnusableDataError),
        ("invalid-input", InvalidInputError),
    ],
)
def test_fail_raises_the_named_reason(
    tmp_path: Path, reason: str, error: type[AnalysisError]
) -> None:
    with pytest.raises(error):
        build_analyze()(_request(tmp_path, f"!fail:{reason}"), report_progress=lambda: None)


def test_fail_without_a_reason_raises(tmp_path: Path) -> None:
    # `parse_scenario` alone accepts a bare "!fail"; the missing reason is only caught once
    # `analyze()` tries to act on it.
    with pytest.raises(ValueError, match="reason must be one of"):
        build_analyze()(_request(tmp_path, "!fail"), report_progress=lambda: None)


def test_fail_with_an_unknown_reason_raises(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="reason must be one of"):
        build_analyze()(_request(tmp_path, "!fail:bogus"), report_progress=lambda: None)


# ----------------------------------------------------------------------------------------------
# !missing-pdf
# ----------------------------------------------------------------------------------------------


def test_missing_pdf_omits_only_the_pdf(tmp_path: Path) -> None:
    outcome = build_analyze()(_request(tmp_path, "!missing-pdf"), report_progress=lambda: None)

    assert not outcome.pdf.exists()
    assert outcome.xlsx.exists()


# ----------------------------------------------------------------------------------------------
# main()
# ----------------------------------------------------------------------------------------------


def test_main_with_no_arguments_is_a_usage_error(capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = main(["worker_child.testing"])

    assert exit_code == names.EXIT_USAGE_ERROR
    assert "usage" in capsys.readouterr().err.lower()


def test_main_runs_the_real_run_with_the_scenario_wired_in(run_directory: Path) -> None:
    exit_code = main(["worker_child.testing", str(run_directory)])

    assert exit_code == names.EXIT_WROTE_RESULT
    assert (run_directory / layout.RESULT).exists()
