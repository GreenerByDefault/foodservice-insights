"""The imports below are the test: they fail if the src layout, the editable install, or the
workspace dependency on `foodservice-insights` break."""

import foodservice_insights
import foodservice_insights_lab


def test_package_is_importable() -> None:
    assert foodservice_insights_lab.__name__ == "foodservice_insights_lab"


def test_analysis_library_is_reachable() -> None:
    assert foodservice_insights.__name__ == "foodservice_insights"
