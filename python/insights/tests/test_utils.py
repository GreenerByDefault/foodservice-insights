"""
Tests for gbd_foodservice_insights/utils.py

This module tests the remaining utility helpers after the
LLM compatibility bridge was removed.
Date parsing tests are in report/test_diagnostics.py.
"""

import logging
from pathlib import Path

import pytest
from gbd_foodservice_insights.utils import (
    get_default_output_file,
    print_progress,
    rel_path,
)

# ----------------------------------------------------------------------
# Tests for path helpers
# ----------------------------------------------------------------------


class TestRelPath:
    """Tests for rel_path helper."""

    def test_returns_none_for_none(self):
        """None input should stay as None."""
        assert rel_path(None) is None

    def test_returns_relative_path_inside_cwd(self, tmp_path, monkeypatch):
        """Paths under the working directory should be shortened."""
        nested_file = tmp_path / "nested" / "file.csv"
        nested_file.parent.mkdir()
        nested_file.write_text("x", encoding="utf-8")
        monkeypatch.chdir(tmp_path)

        assert rel_path(nested_file) == Path("nested/file.csv")


class TestDefaultOutputFile:
    """Tests for output filename helper."""

    def test_appends_suffix_before_extension(self):
        """The helper should keep the extension and add the suffix to the stem."""
        assert get_default_output_file("sample.csv") == "sample_categorized.csv"
        assert get_default_output_file("sample.csv", suffix="_cleaned") == "sample_cleaned.csv"


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


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
