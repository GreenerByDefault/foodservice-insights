"""The lab's diagnostic thresholds, read once from the lab's YAML."""

from functools import cache

import yaml

from gbd_foodservice_insights_lab import PACKAGE_DIR

_THRESHOLDS_PATH = PACKAGE_DIR / "data_files" / "diagnostic_thresholds.yaml"


@cache
def _load_diagnostic_thresholds() -> dict[str, dict[str, float]]:
    loaded = yaml.safe_load(_THRESHOLDS_PATH.read_text())
    return {
        diagnostic_name: {name: float(value) for name, value in thresholds.items()}
        for diagnostic_name, thresholds in loaded.items()
    }


def get_diagnostic_threshold(diagnostic_name: str, threshold_name: str) -> float:
    return _load_diagnostic_thresholds()[diagnostic_name][threshold_name]
