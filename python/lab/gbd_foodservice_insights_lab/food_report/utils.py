"""File-reading helpers for the lab's food-report wrapper."""

import json
from pathlib import Path

import pandas as pd
from gbd_foodservice_insights.report.utils import normalize_diner_meal_mapping


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
