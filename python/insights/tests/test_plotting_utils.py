import matplotlib.font_manager as font_manager
import matplotlib.pyplot as plt
import pandas as pd
import pytest
from gbd_foodservice_insights.plotting_utils import (
    BODY_FONT,
    TITLE_FONT,
    calculate_figure_height_for_wrapped_labels,
    close_new_figures_on_error,
    convert_percentage_to_float,
    format_month_labels,
    format_percentage_column,
    set_suptitle_font,
    set_title_font,
    setup_gbd_fonts,
    standardize_title_case,
    wrap_labels,
)


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


@pytest.mark.parametrize(
    ("labels", "expected"),
    [
        (["Label"], 4.0),
        ([f"Label {i}" for i in range(15)], 15 * 0.35 + 1),
        (["A label that wraps onto two lines"] * 12, 12 * 0.35 * 2 + 1),
    ],
    ids=["never_below_base_height", "grows_with_items", "grows_with_wrapped_lines"],
)
def test_calculate_figure_height_for_wrapped_labels(labels, expected):
    assert calculate_figure_height_for_wrapped_labels(labels) == pytest.approx(expected)


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
