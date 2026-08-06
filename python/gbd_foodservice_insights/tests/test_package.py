"""The import below is the test: it fails if the src layout or the editable install break."""

import gbd_foodservice_insights


def test_package_is_importable() -> None:
    assert gbd_foodservice_insights.__name__ == "gbd_foodservice_insights"
