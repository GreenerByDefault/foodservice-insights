import matplotlib.font_manager as font_manager
import matplotlib.pyplot as plt
import pandas as pd
import pytest
from gbd_foodservice_insights.plotting_utils import (
    BODY_FONT,
    TITLE_FONT,
    close_new_figures_on_error,
    convert_percentage_to_float,
    create_horizontal_percentage_barplot,
    format_month_labels,
    format_percentage_column,
    set_suptitle_font,
    set_title_font,
    set_ylim_with_padding,
    setup_gbd_fonts,
    standardize_title_case,
    wrap_labels,
)
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


def test_titles_use_the_title_font():
    fig, ax = plt.subplots()

    set_title_font(ax, "Panel", fontsize=20)
    set_suptitle_font(fig, "Page")

    assert (ax.title.get_fontname(), ax.title.get_fontsize()) == (TITLE_FONT, 20)
    assert fig.texts[0].get_fontname() == TITLE_FONT


def test_set_ylim_with_padding_scales_each_limit_by_the_padding():
    _fig, ax = plt.subplots()

    set_ylim_with_padding(ax, pd.Series([10, 20, 30]), padding=0.2)

    assert ax.get_ylim() == pytest.approx((8, 36))


@pytest.mark.parametrize(
    "months",
    [
        ["2024-01", "2024-02"],
        pd.to_datetime(["2024-01-01", "2024-02-01"]),
        pd.period_range("2024-01", periods=2, freq="M"),
    ],
    ids=["strings", "datetimes", "periods"],
)
def test_format_month_labels(months):
    assert format_month_labels(months) == ["Jan-2024", "Feb-2024"]


def test_format_month_labels_falls_back_to_str_for_unparseable_values():
    assert format_month_labels([123, "invalid", None]) == ["123", "invalid", "None"]


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
    data = convert_percentage_to_float(
        pd.DataFrame({"product": [f"{prefix} Case A", f"{prefix} Case B"], "percentage": [70, 30]})
    )
    _, ax = plt.subplots()

    create_horizontal_percentage_barplot(ax, data, "product", add_percentage_labels=False)

    assert [bar.get_width() for bar in ax.patches if isinstance(bar, Rectangle)] == [70, 30]
    assert [label.get_text() for label in ax.get_yticklabels()] == [
        "Chicken Breast Boneless\nSkinless Raw Individually\nQuick Frozen 4 Ounce Portion …"
    ] * 2


def test_format_percentage_column_rounds_to_one_decimal_without_mutating_input():
    df = pd.DataFrame({"percentage": [10.0, 10.456]})

    result = format_percentage_column(df)

    assert result["percentage"].tolist() == ["10.0%", "10.5%"]
    assert df["percentage"].tolist() == [10.0, 10.456]


@pytest.mark.parametrize(
    "percentages", [["10.5%", "20.0%"], [10.5, 20.0]], ids=["strings", "numbers"]
)
def test_convert_percentage_to_float(percentages):
    result = convert_percentage_to_float(pd.DataFrame({"percentage": percentages}))

    assert result["percentage_float"].tolist() == [10.5, 20.0]


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
