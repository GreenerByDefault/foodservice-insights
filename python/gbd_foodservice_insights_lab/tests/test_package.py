"""The imports below are the test: they fail if the src layout, the editable install, or the
workspace dependency on `gbd-foodservice-insights` break."""

import gbd_foodservice_insights
import gbd_foodservice_insights_lab


def test_package_is_importable() -> None:
    assert gbd_foodservice_insights_lab.__name__ == "gbd_foodservice_insights_lab"


def test_analysis_library_is_reachable() -> None:
    assert gbd_foodservice_insights.__name__ == "gbd_foodservice_insights"
