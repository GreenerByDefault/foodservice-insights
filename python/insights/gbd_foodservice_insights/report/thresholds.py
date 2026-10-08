"""Diagnostic thresholds, read from the checked-in YAML plus an optional override file."""

from functools import lru_cache
from pathlib import Path
from typing import Any, cast

import yaml

from gbd_foodservice_insights import PACKAGE_DIR

DEFAULT_DIAGNOSTIC_THRESHOLDS_PATH = PACKAGE_DIR / "data_files" / "diagnostic_thresholds.yaml"
DIAGNOSTIC_THRESHOLDS_PATH = DEFAULT_DIAGNOSTIC_THRESHOLDS_PATH


def _load_threshold_mapping(path: Path) -> dict[str, Any]:
    """Load one YAML threshold mapping and validate its top-level shape."""
    if not path.exists():
        raise FileNotFoundError(f"Diagnostic thresholds file not found: {path}")

    with open(path) as f:
        loaded = yaml.safe_load(f) or {}

    if not isinstance(loaded, dict):
        raise ValueError(f"{path.name} must contain a top-level mapping of diagnostic names.")

    return cast(dict[str, Any], loaded)


def _merge_threshold_mappings(
    base_thresholds: dict[str, Any],
    override_thresholds: dict[str, Any],
) -> dict[str, Any]:
    """Merge per-diagnostic threshold overrides on top of the repo defaults."""
    merged = dict(base_thresholds)
    for diagnostic_name, override_value in override_thresholds.items():
        base_value = merged.get(diagnostic_name)
        if isinstance(base_value, dict) and isinstance(override_value, dict):
            merged[diagnostic_name] = {**base_value, **override_value}
        else:
            merged[diagnostic_name] = override_value
    return merged


def _threshold_cache_key(path: Path) -> tuple[str, int]:
    """Build a cache key that changes when the thresholds file path or contents change."""
    resolved_path = path.resolve()
    return str(resolved_path), resolved_path.stat().st_mtime_ns


@lru_cache(maxsize=8)
def _load_diagnostic_thresholds_cached(
    default_path_str: str,
    current_path_str: str,
    default_mtime_ns: int,
    current_mtime_ns: int,
) -> dict[str, Any]:
    """Cache threshold loading by file path and last-modified time."""
    default_path = Path(default_path_str)
    current_path = Path(current_path_str)

    # The mtime values are part of the cache key and intentionally unused here.
    del default_mtime_ns, current_mtime_ns

    base_thresholds = _load_threshold_mapping(default_path)
    if current_path == default_path:
        return base_thresholds

    override_thresholds = _load_threshold_mapping(current_path)
    return _merge_threshold_mappings(base_thresholds, override_thresholds)


def _load_diagnostic_thresholds() -> dict[str, Any]:
    """Load diagnostic thresholds from the checked-in YAML plus any override file."""
    default_path_key, default_mtime_ns = _threshold_cache_key(DEFAULT_DIAGNOSTIC_THRESHOLDS_PATH)
    current_path_key, current_mtime_ns = _threshold_cache_key(DIAGNOSTIC_THRESHOLDS_PATH)
    return _load_diagnostic_thresholds_cached(
        default_path_key,
        current_path_key,
        default_mtime_ns,
        current_mtime_ns,
    )


def get_diagnostic_threshold(
    diagnostic_name: str,
    threshold_name: str,
) -> float:
    """Read one threshold from YAML and fail loudly if config is incomplete."""
    thresholds = _load_diagnostic_thresholds()
    diagnostic_thresholds = thresholds.get(diagnostic_name)
    if not isinstance(diagnostic_thresholds, dict):
        raise KeyError(
            f"Thresholds for diagnostic '{diagnostic_name}' must be defined as a mapping in "
            f"{DIAGNOSTIC_THRESHOLDS_PATH.name}."
        )

    if threshold_name not in diagnostic_thresholds:
        raise KeyError(
            f"Missing threshold '{diagnostic_name}.{threshold_name}' in "
            f"{DIAGNOSTIC_THRESHOLDS_PATH.name}."
        )

    value = diagnostic_thresholds[threshold_name]
    try:
        return float(value)
    except (TypeError, ValueError) as err:
        raise ValueError(
            f"Threshold '{diagnostic_name}.{threshold_name}' must be numeric; got {value!r}."
        ) from err


def resolve_diagnostic_threshold(
    diagnostic_name: str,
    threshold_name: str,
    override: float | None,
) -> float:
    """Return an explicit override when provided, otherwise read from YAML."""
    if override is not None:
        return float(override)
    return get_diagnostic_threshold(diagnostic_name, threshold_name)
