"""
Tests for gbd_foodservice_insights_lab/plotting_extras.py

This module tests lab-only plotting utilities with no product caller.
"""

import matplotlib
import matplotlib.pyplot as plt
import pandas as pd
import pytest

matplotlib.use("Agg")  # Use non-interactive backend for testing

from gbd_foodservice_insights_lab.plotting_extras import (
    PERIOD_COLORS,
    calculate_subplot_grid,
    clean_category_label,
    create_line_plot_with_periods,
    hide_unused_subplots,
    setup_seaborn_palette,
)

# ----------------------------------------------------------------------
# Tests for constants
# ----------------------------------------------------------------------


class TestConstants:
    """Tests for module-level constants."""

    def test_period_colors_has_baseline_and_pilot(self):
        assert "baseline" in PERIOD_COLORS
        assert "pilot" in PERIOD_COLORS


# ----------------------------------------------------------------------
# Tests for font configuration
# ----------------------------------------------------------------------


class TestFontConfiguration:
    """Tests for font configuration functions."""

    def test_setup_seaborn_palette_runs_without_error(self):
        # Should not raise any exceptions
        setup_seaborn_palette()


# ----------------------------------------------------------------------
# Tests for plotting utilities
# ----------------------------------------------------------------------


class TestCalculateSubplotGrid:
    """Tests for calculate_subplot_grid function."""

    def test_returns_tuple(self):
        result = calculate_subplot_grid(10)
        assert isinstance(result, tuple)
        assert len(result) == 2

    def test_single_item(self):
        rows, _cols = calculate_subplot_grid(1, n_cols=4)
        assert rows == 1

    def test_exact_fit(self):
        rows, cols = calculate_subplot_grid(8, n_cols=4)
        assert rows == 2
        assert cols == 4

    def test_partial_row(self):
        rows, _cols = calculate_subplot_grid(10, n_cols=4)
        assert rows == 3  # 10 items / 4 cols = 2.5 -> 3 rows

    def test_custom_n_cols(self):
        rows, cols = calculate_subplot_grid(6, n_cols=2)
        assert rows == 3
        assert cols == 2


class TestHideUnusedSubplots:
    """Tests for hide_unused_subplots function."""

    def test_hides_extra_subplots(self):
        fig, axes = plt.subplots(2, 2)
        axes_flat = axes.flatten()
        hide_unused_subplots(list(axes_flat), n_used=3)

        # Last subplot should be invisible
        assert not axes_flat[3].get_visible()
        # First three should be visible
        for i in range(3):
            assert axes_flat[i].get_visible()
        plt.close(fig)

    def test_no_hiding_when_all_used(self):
        fig, axes = plt.subplots(1, 3)
        hide_unused_subplots(list(axes), n_used=3)

        for ax in axes:
            assert ax.get_visible()
        plt.close(fig)


class TestCleanCategoryLabel:
    """Tests for clean_category_label function."""

    def test_returns_string(self):
        result = clean_category_label("test_label")
        assert isinstance(result, str)

    def test_handles_invalid_gracefully(self):
        result = clean_category_label("Not A Valid Category 12345")
        assert result == "Not A Valid Category 12345"


class TestCreateLinePlotWithPeriods:
    """Tests for create_line_plot_with_periods function."""

    def test_creates_line_plot(self):
        fig, ax = plt.subplots()
        data = pd.DataFrame(
            {
                "month": [1, 2, 3, 4],
                "value": [10, 20, 15, 25],
                "period": ["baseline", "baseline", "pilot", "pilot"],
            }
        )
        create_line_plot_with_periods(ax, data, "month", "value")
        # Should have created lines
        assert len(ax.lines) > 0
        plt.close(fig)


# Clean up matplotlib
@pytest.fixture(autouse=True)
def cleanup_plt():
    """Clean up matplotlib figures after each test."""
    yield
    plt.close("all")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
