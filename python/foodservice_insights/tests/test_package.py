"""The import below is the test: it fails if the src layout or the editable install break."""

import foodservice_insights


def test_package_is_importable() -> None:
    assert foodservice_insights.__name__ == "foodservice_insights"
