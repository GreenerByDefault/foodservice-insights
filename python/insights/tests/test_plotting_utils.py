import warnings

import matplotlib.font_manager as font_manager
import matplotlib.pyplot as plt
import pandas as pd
import pytest
from gbd_foodservice_insights.plotting_utils import (
    BODY_FONT,
    GBD_GREEN,
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
from matplotlib.colors import to_hex
from matplotlib.patches import Rectangle


def test_setup_gbd_fonts_registers_title_and_body_fonts():
    setup_gbd_fonts()
    registered_names = {f.name for f in font_manager.fontManager.ttflist}
    assert {*TITLE_FONT, *BODY_FONT} <= registered_names


@pytest.mark.parametrize("family", [TITLE_FONT, BODY_FONT])
@pytest.mark.parametrize("weight", ["normal", "bold"])
def test_fonts_render_the_co2e_subscript_two(family: tuple[str, ...], weight: str):
    """The report writes "CO₂e"; a missing glyph would render as a box."""
    fig = plt.figure()
    fig.text(0, 0, "CO₂e", fontfamily=family, fontweight=weight)

    with warnings.catch_warnings(action="error"):
        fig.canvas.draw()


def test_default_text_renders_the_co2e_subscript_two():
    fig, ax = plt.subplots()
    ax.set_xlabel("kg CO₂e")

    with warnings.catch_warnings(action="error"):
        fig.canvas.draw()


def test_titles_use_the_title_font():
    fig, ax = plt.subplots()

    set_title_font(ax, "Panel", fontsize=20)
    set_suptitle_font(fig, "Page")

    assert (tuple(ax.title.get_fontfamily()), ax.title.get_fontsize()) == (TITLE_FONT, 20)
    assert tuple(fig.texts[0].get_fontfamily()) == TITLE_FONT


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


def test_horizontal_percentage_barplot_draws_every_bar_in_gbd_green_without_warning():
    data = pd.DataFrame({"product": [f"Product {i}" for i in range(3)], "percentage": [10] * 3})
    _, ax = plt.subplots()

    with warnings.catch_warnings(action="error"):
        create_horizontal_percentage_barplot(ax, data, "product", add_percentage_labels=False)

    assert [to_hex(bar.get_facecolor()) for bar in ax.patches if isinstance(bar, Rectangle)] == [
        GBD_GREEN.lower()
    ] * 3


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
