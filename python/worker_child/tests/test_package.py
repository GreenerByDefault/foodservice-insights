import gbd_foodservice_insights
import worker_child


def test_package_is_importable() -> None:
    assert worker_child.__name__ == "worker_child"


def test_analysis_library_is_reachable() -> None:
    assert gbd_foodservice_insights.__name__ == "gbd_foodservice_insights"
