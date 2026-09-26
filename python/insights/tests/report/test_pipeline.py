import numpy as np
import pandas as pd
from gbd_foodservice_insights.report.pipeline import _attach_monthly_category_emissions

JAN = pd.Period("2024-01", freq="M")
FEB = pd.Period("2024-02", freq="M")


def test_attach_monthly_category_emissions_keeps_each_category_share():
    raw = pd.DataFrame(
        {
            "month_year": [JAN, JAN, JAN, JAN, FEB],
            "category": ["beef", "beef", "legumes", None, "beef"],
            "emissions_kg_co2e": [30.0, 10.0, 2.0, 1.0, 50.0],
        }
    )
    monthly_cat = pd.DataFrame(
        {
            "month_year": [JAN, JAN, JAN, FEB],
            "category": ["beef", "legumes", None, "beef"],
            "kilos_total": [4.0, 3.0, 1.0, 5.0],
        }
    )

    out = _attach_monthly_category_emissions(monthly_cat, raw)

    pd.testing.assert_frame_equal(
        out,
        monthly_cat.assign(emissions_kg_co2e=[40.0, 2.0, 1.0, 50.0]),
    )


def test_attach_monthly_category_emissions_leaves_unfactored_category_missing():
    raw = pd.DataFrame(
        {
            "month_year": [JAN, JAN],
            "category": ["beef", "mystery"],
            "emissions_kg_co2e": [30.0, np.nan],
        }
    )
    monthly_cat = pd.DataFrame(
        {
            "month_year": [JAN, JAN],
            "category": ["beef", "mystery"],
            "kilos_total": [4.0, 3.0],
        }
    )

    out = _attach_monthly_category_emissions(monthly_cat, raw)

    pd.testing.assert_frame_equal(
        out,
        monthly_cat.assign(emissions_kg_co2e=[30.0, np.nan]),
    )
