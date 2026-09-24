"""
Tests for gbd_foodservice_insights/plotting_utils.py

This module tests shared plotting utilities, including color palettes, font
configuration, and common plotting helper functions.
"""

import matplotlib
import matplotlib.pyplot as plt
import pandas as pd
import pytest

matplotlib.use("Agg")  # Use non-interactive backend for testing

from gbd_foodservice_insights.plotting_utils import (
    BODY_FONT,
    TITLE_FONT,
    GBD_colors,
    add_grid,
    calculate_figure_height_for_wrapped_labels,
    convert_percentage_to_float,
    create_horizontal_percentage_barplot,
    format_month_labels,
    format_percentage_column,
    plot_time_series_with_periods,
    rotate_x_labels,
    set_suptitle_font,
    set_title_font,
    set_ylim_with_padding,
    setup_gbd_fonts,
    standardize_title_case,
    wrap_labels,
)

# ----------------------------------------------------------------------
# Tests for constants
# ----------------------------------------------------------------------


class TestConstants:
    """Tests for module-level constants."""

    def test_gbd_colors_is_list(self):
        assert isinstance(GBD_colors, list)

    def test_gbd_colors_has_expected_length(self):
        assert len(GBD_colors) == 7

    def test_gbd_colors_are_valid_hex(self):
        for color in GBD_colors:
            assert color.startswith("#")
            assert len(color) == 7
            # Check valid hex characters
            int(color[1:], 16)  # Should not raise

    def test_font_constants_are_strings(self):
        assert isinstance(TITLE_FONT, str)
        assert isinstance(BODY_FONT, str)


# ----------------------------------------------------------------------
# Tests for font configuration
# ----------------------------------------------------------------------


class TestFontConfiguration:
    """Tests for font configuration functions."""

    def test_setup_gbd_fonts_runs_without_error(self):
        # Should not raise any exceptions
        setup_gbd_fonts()

    def test_set_title_font_sets_title(self):
        fig, ax = plt.subplots()
        set_title_font(ax, "Test Title")
        assert ax.get_title() == "Test Title"
        plt.close(fig)

    def test_set_title_font_uses_fontsize(self):
        fig, ax = plt.subplots()
        set_title_font(ax, "Test Title", fontsize=20)
        assert ax.get_title() == "Test Title"
        assert ax.title.get_fontsize() == 20
        plt.close(fig)

    def test_set_suptitle_font_sets_suptitle(self):
        fig, _ax = plt.subplots()
        set_suptitle_font(fig, "Test Suptitle")
        assert fig.texts
        assert fig.texts[0].get_text() == "Test Suptitle"
        plt.close(fig)


# ----------------------------------------------------------------------
# Tests for plotting utilities
# ----------------------------------------------------------------------


class TestSetYlimWithPadding:
    """Tests for set_ylim_with_padding function."""

    def test_sets_ylim_with_padding(self):
        fig, ax = plt.subplots()
        data = pd.Series([10, 20, 30])
        set_ylim_with_padding(ax, data, padding=0.2)

        ymin, ymax = ax.get_ylim()
        # Should have padding below and above
        assert ymin < 10
        assert ymax > 30
        plt.close(fig)


class TestFormatMonthLabels:
    """Tests for format_month_labels function."""

    def test_formats_string_dates(self):
        months = ["2024-01", "2024-02", "2024-03"]
        result = format_month_labels(months)

        assert len(result) == 3
        assert all(isinstance(label, str) for label in result)
        # Should be in Mon-YYYY format
        assert "Jan" in result[0] or "jan" in result[0].lower()

    def test_handles_datetime(self):
        months = pd.to_datetime(["2024-01-01", "2024-02-01"])
        result = format_month_labels(months)

        assert len(result) == 2
        assert all(isinstance(label, str) for label in result)

    def test_handles_period(self):
        months = pd.period_range("2024-01", periods=3, freq="M")
        result = format_month_labels(months)

        assert len(result) == 3
        assert all(isinstance(label, str) for label in result)

    def test_handles_invalid_gracefully(self):
        months = [123, "invalid", None]
        result = format_month_labels(months)

        assert len(result) == 3
        assert all(isinstance(label, str) for label in result)


class TestRotateXLabels:
    """Tests for rotate_x_labels function."""

    def test_rotates_labels(self):
        fig, ax = plt.subplots()
        ax.plot([1, 2, 3], [1, 2, 3])
        ax.set_xticks([1, 2, 3])
        ax.set_xticklabels(["A", "B", "C"])
        rotate_x_labels(ax, rotation=45)
        assert ax.get_xticklabels()[0].get_rotation() == 45
        plt.close(fig)


class TestAddGrid:
    """Tests for add_grid function."""

    def test_adds_grid(self):
        fig, ax = plt.subplots()
        ax.plot([1, 2, 3], [1, 2, 3])
        add_grid(ax)
        # Grid should be visible
        assert (
            ax.xaxis.get_gridlines()[0].get_visible() or ax.yaxis.get_gridlines()[0].get_visible()
        )
        plt.close(fig)

    def test_custom_axis(self):
        fig, ax = plt.subplots()
        add_grid(ax, axis="y")
        assert any(line.get_visible() for line in ax.yaxis.get_gridlines())
        plt.close(fig)

    def test_custom_style(self):
        fig, ax = plt.subplots()
        add_grid(ax, linestyle=":", alpha=0.5)
        visible_lines = [
            line for line in ax.get_xgridlines() + ax.get_ygridlines() if line.get_visible()
        ]
        assert visible_lines, "Expected at least one visible grid line"
        assert visible_lines[0].get_linestyle() == ":"
        assert visible_lines[0].get_alpha() == 0.5
        plt.close(fig)


class TestWrapLabels:
    """Tests for wrap_labels function."""

    def test_wraps_long_labels(self):
        labels = ["This is a very long label that should be wrapped"]
        result = wrap_labels(labels, max_width=20)

        assert len(result) == 1
        assert "\n" in result[0]

    def test_does_not_wrap_short_labels(self):
        labels = ["Short"]
        result = wrap_labels(labels, max_width=20)

        assert result == ["Short"]

    def test_handles_multiple_labels(self):
        labels = ["Short", "This is a very long label"]
        result = wrap_labels(labels, max_width=15)

        assert len(result) == 2
        assert "\n" not in result[0]  # Short one not wrapped
        assert "\n" in result[1]  # Long one wrapped


class TestFormatPercentageColumn:
    """Tests for format_percentage_column function."""

    def test_adds_percent_suffix(self):
        df = pd.DataFrame({"percentage": [10.0, 20.5, 30.123]})
        result = format_percentage_column(df)

        assert all("%" in str(val) for val in result["percentage"])

    def test_rounds_to_one_decimal(self):
        df = pd.DataFrame({"percentage": [10.456]})
        result = format_percentage_column(df)

        assert "10.5%" in result["percentage"].iloc[0]

    def test_does_not_modify_original(self):
        df = pd.DataFrame({"percentage": [10.0]})
        original_value = df["percentage"].iloc[0]
        format_percentage_column(df)

        assert df["percentage"].iloc[0] == original_value


class TestStandardizeTitleCase:
    """Tests for standardize_title_case function."""

    def test_converts_to_title_case(self):
        result = standardize_title_case("hello world")
        assert result == "Hello World"

    def test_handles_mixed_case(self):
        result = standardize_title_case("HELLO world")
        assert result == "Hello World"


class TestConvertPercentageToFloat:
    """Tests for convert_percentage_to_float function."""

    def test_converts_string_percentages(self):
        df = pd.DataFrame({"percentage": ["10.5%", "20.0%", "30.1%"]})
        result = convert_percentage_to_float(df)

        # Function creates a new column with _float suffix
        assert "percentage_float" in result.columns
        assert result["percentage_float"].dtype == float
        assert result["percentage_float"].iloc[0] == 10.5

    def test_handles_already_numeric(self):
        df = pd.DataFrame({"percentage": [10.5, 20.0, 30.1]})
        result = convert_percentage_to_float(df)

        assert "percentage_float" in result.columns
        assert result["percentage_float"].dtype == float


class TestCalculateFigureHeightForWrappedLabels:
    """Tests for calculate_figure_height_for_wrapped_labels function."""

    def test_returns_float(self):
        result = calculate_figure_height_for_wrapped_labels(["Label 1", "Label 2"])
        assert isinstance(result, float)

    def test_increases_with_more_labels(self):
        # Use many labels to exceed the base height of 4.0
        short_height = calculate_figure_height_for_wrapped_labels(["Label"])
        long_height = calculate_figure_height_for_wrapped_labels(
            [f"Label {i}" for i in range(15)]  # Many labels to exceed base_height
        )

        assert long_height > short_height

    def test_increases_with_longer_labels(self):
        short_height = calculate_figure_height_for_wrapped_labels(["Short"], max_width=30)
        long_height = calculate_figure_height_for_wrapped_labels(
            ["This is a very long label that will need to be wrapped"], max_width=15
        )

        assert long_height >= short_height


class TestPlotTimeSeriesWithPeriods:
    """Tests for plot_time_series_with_periods function."""

    def test_returns_figure(self):
        data = pd.DataFrame(
            {
                "month_year": ["2024-01", "2024-02", "2024-03"],
                "value": [10, 20, 15],
                "period": ["baseline", "baseline", "pilot"],
            }
        )
        fig = plot_time_series_with_periods(data, "value", "Value", "Test Title")
        assert isinstance(fig, plt.Figure)
        assert len(fig.axes[0].lines) > 0
        plt.close(fig)


class TestCreateHorizontalPercentageBarplot:
    """Tests for create_horizontal_percentage_barplot function."""

    def test_creates_barplot(self):
        fig, ax = plt.subplots()
        data = pd.DataFrame({"product": ["A", "B", "C"], "percentage": [30.0, 50.0, 20.0]})
        # Must preprocess with convert_percentage_to_float as per docstring
        data = convert_percentage_to_float(data)
        create_horizontal_percentage_barplot(ax, data, "product")
        assert len(ax.patches) == 3
        plt.close(fig)


# Clean up matplotlib
@pytest.fixture(autouse=True)
def cleanup_plt():
    """Clean up matplotlib figures after each test."""
    yield
    plt.close("all")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
