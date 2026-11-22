from gbd_foodservice_insights.plotting_utils import BODY_FONT
from gbd_foodservice_insights.report.pdf.layout import wrap_to_width
from matplotlib.font_manager import FontProperties
from matplotlib.textpath import text_to_path


def test_wrap_to_width_fits_measured_width_without_losing_words() -> None:
    text = "Producing that food released an estimated 1,931 kg of carbon dioxide equivalent " * 3

    lines = wrap_to_width(text, max_width_in=3.0, fontsize=11.5, fontfamily=BODY_FONT)

    assert len(lines) > 1
    assert " ".join(lines) == " ".join(text.split())
    assert all(
        text_to_path.get_text_width_height_descent(
            line, FontProperties(family=BODY_FONT, size=11.5), ismath=False
        )[0]
        <= 3.0 * 72
        for line in lines
    )


def test_wrap_to_width_keeps_an_overlong_word_on_its_own_line() -> None:
    assert wrap_to_width("a " + "x" * 200 + " b", 1.0, fontsize=12, fontfamily=BODY_FONT) == [
        "a",
        "x" * 200,
        "b",
    ]
    assert wrap_to_width("   ", 1.0, fontsize=12, fontfamily=BODY_FONT) == []
