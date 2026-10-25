from collections.abc import Callable

import pandas as pd
import pytest
from gbd_foodservice_insights.report.plots import panels


@pytest.fixture
def fruit_and_juice(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(panels, "food_categories", lambda: ["fruit"])
    monkeypatch.setattr(panels, "drink_categories", lambda: ["juice"])


@pytest.fixture
def fruit_and_juice_months(fruit_and_juice: None) -> Callable[..., pd.DataFrame]:
    """Two months of fruit (food) and juice (drink), with any extra columns given."""

    def months(**extra_columns: list[float]) -> pd.DataFrame:
        return pd.DataFrame(
            {
                "month_year": [
                    pd.Period("2023-01"),
                    pd.Period("2023-01"),
                    pd.Period("2023-02"),
                    pd.Period("2023-02"),
                ],
                "category": ["fruit", "juice", "fruit", "juice"],
                "kilos_total": [100, 25, 150, 40],
                **extra_columns,
            }
        )

    return months
