"""File-reading helpers for the lab's food-report wrapper."""

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any, cast, get_args

import pandas as pd
from gbd_foodservice_insights.report.schema import Region


def _to_month_period(value: Any, *, context: str) -> pd.Period:
    """Convert one month-like value to a real monthly Period or fail clearly."""
    try:
        period = pd.Period(str(value), freq="M")
    except Exception as exc:
        raise ValueError(f"Invalid {context} month {value!r}: {exc}") from exc

    if not isinstance(period, pd.Period):
        raise ValueError(f"Invalid {context} month {value!r}: value is missing")
    return period


def normalize_diner_meal_mapping(raw_mapping: Mapping[Any, Any]) -> dict[pd.Period, float]:
    """Normalize a month->count mapping to ``{Period[M]: float}``.

    Raises a ``ValueError`` on invalid keys/values.
    """
    if not isinstance(raw_mapping, Mapping):
        raise ValueError("Diner-meal mapping must be a mapping object.")

    normalized: dict[pd.Period, float] = {}
    for key, value in raw_mapping.items():
        period_key = _to_month_period(key, context="diner-meal mapping")

        try:
            normalized[period_key] = float(value)
        except Exception as exc:
            raise ValueError(f"Invalid diner-meal count for month {key!r}: {value!r}") from exc

    if not normalized:
        raise ValueError("Diner-meal mapping is empty after normalization.")

    return normalized


def load_diner_meal_mapping_from_json(
    diner_meal_file: str | Path | None,
) -> dict[pd.Period, float]:
    """Load and normalize diner-meal mapping from a JSON file."""
    if diner_meal_file is None:
        raise ValueError("diner_meal_file is required when diner_meal_mapping is not provided.")

    dm_path = Path(diner_meal_file).resolve()
    if not dm_path.exists():
        raise FileNotFoundError(f"Diner-meal JSON not found: {dm_path}")

    with open(dm_path) as f:
        raw = json.load(f)

    return normalize_diner_meal_mapping(raw)


def validate_region(region: str) -> Region:
    """Validate and normalize region identifier."""
    normalized = str(region).strip().lower()
    if normalized not in get_args(Region):
        raise ValueError(f"region must be one of {list(get_args(Region))}, got '{region}'")
    return cast(Region, normalized)
