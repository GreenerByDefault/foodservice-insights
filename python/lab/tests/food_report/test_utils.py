import pandas as pd
import pytest
from gbd_foodservice_insights_lab.food_report.utils import normalize_diner_meal_mapping


def test_normalize_diner_meal_mapping_keys_by_month_period():
    assert normalize_diner_meal_mapping({"2024-01": 100, "2024-02": "200"}) == {
        pd.Period("2024-01", freq="M"): 100.0,
        pd.Period("2024-02", freq="M"): 200.0,
    }


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        ({"bad-month": 1}, "Invalid diner-meal mapping month 'bad-month'"),
        ({"NaT": 1}, "value is missing"),
        ({"2024-01": "many"}, "Invalid diner-meal count for month '2024-01'"),
        ({}, "empty after normalization"),
    ],
)
def test_normalize_diner_meal_mapping_rejects_bad_entries(raw: dict, message: str):
    with pytest.raises(ValueError, match=message):
        normalize_diner_meal_mapping(raw)
