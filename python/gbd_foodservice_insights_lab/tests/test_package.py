import gbd_foodservice_insights
import gbd_foodservice_insights_lab


def test_package_is_importable() -> None:
    assert gbd_foodservice_insights_lab.__name__ == "gbd_foodservice_insights_lab"


def test_analysis_library_is_reachable() -> None:
    assert gbd_foodservice_insights.__name__ == "gbd_foodservice_insights"
