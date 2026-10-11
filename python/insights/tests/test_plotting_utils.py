import warnings

import matplotlib.font_manager as font_manager
import matplotlib.pyplot as plt
import pandas as pd
import pytest
from gbd_foodservice_insights import PACKAGE_DIR
from gbd_foodservice_insights.plotting_utils import (
    BODY_FONT,
    FONT_FILES,
    GBD_COLORS,
    TITLE_FONT,
    close_new_figures_on_error,
    create_horizontal_percentage_barplot,
    format_month_labels,
    set_suptitle_font,
    set_title_font,
    setup_gbd_fonts,
    standardize_title_case,
    wrap_labels,
)
from matplotlib.ft2font import FT2Font
from matplotlib.patches import Rectangle


@pytest.fixture(autouse=True)
def cleanup_plt():
    yield
    plt.close("all")


def test_setup_gbd_fonts_registers_title_and_body_fonts():
    setup_gbd_fonts()
    registered_names = {f.name for f in font_manager.fontManager.ttflist}
    assert TITLE_FONT in registered_names
    assert BODY_FONT in registered_names


@pytest.mark.parametrize("font_file", FONT_FILES)
def test_packaged_fonts_have_the_co2e_subscript_two(font_file: str):
    """The report writes "CO₂e"; a font without U+2082 would render it as a missing-glyph box."""
    font = FT2Font(str(PACKAGE_DIR / "data_files" / "fonts" / font_file))
    assert font.get_char_index(0x2082) != 0


def test_titles_use_the_title_font():
    fig, ax = plt.subplots()

    set_title_font(ax, "Panel", fontsize=20)
    set_suptitle_font(fig, "Page")

    assert (ax.title.get_fontname(), ax.title.get_fontsize()) == (TITLE_FONT, 20)
    assert fig.texts[0].get_fontname() == TITLE_FONT


def test_format_month_labels_formats_periods():
    assert format_month_labels(pd.period_range("2024-01", periods=2, freq="M")) == [
        "Jan-2024",
        "Feb-2024",
    ]


def test_wrap_labels_wraps_only_labels_longer_than_max_width():
    assert wrap_labels(["Short", "This is a very long label"], max_width=15) == [
        "Short",
        "This is a very\nlong label",
    ]


def test_wrap_labels_ends_in_an_ellipsis_past_max_lines():
    assert wrap_labels(["one two three four five six"], max_width=9, max_lines=2) == [
        "one two\nthree …"
    ]


def test_horizontal_percentage_barplot_keeps_labels_that_truncate_alike_as_separate_bars():
    prefix = "Chicken Breast Boneless Skinless Raw Individually Quick Frozen 4 Ounce Portion"
    data = pd.DataFrame(
        {"product": [f"{prefix} Case A", f"{prefix} Case B"], "percentage": [70, 30]}
    )
    _, ax = plt.subplots()

    create_horizontal_percentage_barplot(ax, data, "product", add_percentage_labels=False)

    assert [bar.get_width() for bar in ax.patches if isinstance(bar, Rectangle)] == [70, 30]
    assert [label.get_text() for label in ax.get_yticklabels()] == [
        "Chicken Breast Boneless\nSkinless Raw Individually\nQuick Frozen 4 Ounce Portion …"
    ] * 2


@pytest.mark.parametrize("bar_count", [2, len(GBD_COLORS) + 2])
def test_horizontal_percentage_barplot_cycles_the_palette_without_warning(
    bar_count: int,
):
    data = pd.DataFrame(
        {"product": [f"Product {i}" for i in range(bar_count)], "percentage": [10] * bar_count}
    )
    _, ax = plt.subplots()

    with warnings.catch_warnings(action="error"):
        create_horizontal_percentage_barplot(ax, data, "product", add_percentage_labels=False)

    colors = [bar.get_facecolor() for bar in ax.patches if isinstance(bar, Rectangle)]
    assert len(set(colors)) == min(bar_count, len(GBD_COLORS))
    assert colors == [colors[i % len(GBD_COLORS)] for i in range(bar_count)]


def test_standardize_title_case_keeps_possessive_s_lowercase():
    assert standardize_title_case("FARMER'S oat milk") == "Farmer's Oat Milk"


def test_close_new_figures_on_error_closes_only_the_figures_opened_in_the_block():
    before = set(plt.get_fignums())
    kept = plt.figure()

    with pytest.raises(RuntimeError, match="boom"), close_new_figures_on_error():
        plt.figure()
        plt.figure()
        raise RuntimeError("boom")

    assert set(plt.get_fignums()) == before | {kept.number}


def test_close_new_figures_on_error_leaves_figures_open_on_success():
    before = set(plt.get_fignums())

    with close_new_figures_on_error():
        fig = plt.figure()

    assert set(plt.get_fignums()) == before | {fig.number}
