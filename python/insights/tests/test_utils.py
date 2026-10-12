import logging
import re
import threading
import time

import pytest
from gbd_foodservice_insights.utils import (
    map_concurrently,
    print_progress,
)

# ----------------------------------------------------------------------
# Tests for print_progress
# ----------------------------------------------------------------------


class TestPrintProgress:
    """Tests for print_progress function."""

    def test_prints_at_intervals(self, caplog):
        with caplog.at_level(logging.DEBUG, logger="gbd_foodservice_insights.utils"):
            for i in range(1, 11):
                print_progress("Test", i, 10, updates=5)

        assert "Test:" in caplog.text

    def test_prints_at_100_percent(self, caplog):
        with caplog.at_level(logging.DEBUG, logger="gbd_foodservice_insights.utils"):
            print_progress("Test", 10, 10, updates=5)
        assert "100%" in caplog.text

    def test_handles_zero_total(self, caplog):
        with caplog.at_level(logging.DEBUG, logger="gbd_foodservice_insights.utils"):
            print_progress("Test", 1, 0, updates=5)
        assert caplog.text == ""

    def test_handles_negative_total(self, caplog):
        with caplog.at_level(logging.DEBUG, logger="gbd_foodservice_insights.utils"):
            print_progress("Test", 1, -5, updates=5)
        assert caplog.text == ""

    def test_format_includes_prefix(self, caplog):
        with caplog.at_level(logging.DEBUG, logger="gbd_foodservice_insights.utils"):
            print_progress("Custom Prefix", 10, 10, updates=5)
        assert "Custom Prefix:" in caplog.text

    def test_format_includes_current_and_total(self, caplog):
        with caplog.at_level(logging.DEBUG, logger="gbd_foodservice_insights.utils"):
            print_progress("Test", 10, 10, updates=5)
        assert "(10/10)" in caplog.text

    def test_updates_parameter_controls_frequency(self, caplog):
        with caplog.at_level(logging.DEBUG, logger="gbd_foodservice_insights.utils"):
            for i in range(1, 11):
                print_progress("Test", i, 10, updates=2)

        lines = [r for r in caplog.records if r.name == "gbd_foodservice_insights.utils"]
        assert len(lines) >= 2


# ----------------------------------------------------------------------
# Tests for map_concurrently
# ----------------------------------------------------------------------


def test_map_concurrently_returns_results_in_input_order_when_calls_finish_out_of_order():
    finished = {n: threading.Event() for n in range(3)}

    def call(n: int) -> int:
        if n + 1 in finished:
            assert finished[n + 1].wait(timeout=5)
        finished[n].set()
        return n * 10

    assert map_concurrently(call, [0, 1, 2], max_workers=3, progress_prefix="Test") == [0, 10, 20]


def test_map_concurrently_starts_no_call_after_a_failure():
    started = []

    def call(n: int) -> int:
        started.append(n)
        raise ValueError(f"call {n} failed")

    with pytest.raises(ValueError, match="call 0 failed"):
        map_concurrently(call, [0, 1, 2], max_workers=1, progress_prefix="Test")
    assert started == [0]


def test_map_concurrently_lets_calls_in_flight_finish_before_raising():
    failed = threading.Event()
    finished = []

    def call(n: int) -> int:
        if n == 0:
            failed.set()
            raise ValueError("call 0 failed")
        assert failed.wait(timeout=5)
        # Outlasts the failure reaching the caller, so raising without waiting would be caught.
        # The sleep cannot make a correct implementation fail.
        time.sleep(0.1)
        finished.append(n)
        return n

    with pytest.raises(ValueError, match="call 0 failed"):
        map_concurrently(call, [0, 1], max_workers=2, progress_prefix="Test")
    assert finished == [1]


def test_map_concurrently_logs_progress_per_completion(caplog):
    with caplog.at_level(logging.INFO, logger="gbd_foodservice_insights.utils"):
        results = map_concurrently(
            lambda n: n * 10, [0, 1, 2], max_workers=2, progress_prefix="Test"
        )

    assert results == [0, 10, 20]
    assert [re.sub(r"\d+\.\d s", "<elapsed> s", m) for m in caplog.messages] == [
        "Test: 33% (1/3)",
        "Test: 66% (2/3)",
        "Test: 100% (3/3)",
        "Test: 3 calls in <elapsed> s, 2 at a time.",
    ]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
