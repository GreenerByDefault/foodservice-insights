import pytest
from gbd_foodservice_insights_lab.food_report.pipeline import _normalize_report_mode


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, "procurement"),
        ("procurement", "procurement"),
        (" Serving ", "serving"),
        ("baseline_servings", "serving"),
        ("purchasing", "procurement"),
    ],
)
def test_normalize_report_mode(value, expected):
    assert _normalize_report_mode(value) == expected
