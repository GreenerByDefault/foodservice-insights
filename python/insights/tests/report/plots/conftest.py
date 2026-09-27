from collections.abc import Callable

import matplotlib.pyplot as plt
import pandas as pd
import pytest
from gbd_foodservice_insights.report.plots import panels


@pytest.fixture(autouse=True)
def cleanup_plt():
    yield
    plt.close("all")


@pytest.fixture
def fruit_and_juice(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(panels, "get_food_categories", lambda **_: ["fruit"])
    monkeypatch.setattr(panels, "get_drink_categories", lambda **_: ["juice"])


@pytest.fixture
def fruit_and_juice_months(fruit_and_juice: None) -> Callable[..., pd.DataFrame]:
    """Two months of fruit (food) and juice (drink), with any extra columns given."""

    def months(**extra_columns: list[float]) -> pd.DataFrame:
        return pd.DataFrame(
            {
                "month_year": ["2023-01", "2023-01", "2023-02", "2023-02"],
                "category": ["fruit", "juice", "fruit", "juice"],
                "kilos_total": [100, 25, 150, 40],
                **extra_columns,
            }
        )

    return months
