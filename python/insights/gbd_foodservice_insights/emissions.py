"""Emission factor lookup and carbon metric calculations."""

from functools import cache

import numpy as np
import pandas as pd

from gbd_foodservice_insights.categories import categories
from gbd_foodservice_insights.report.schema import DinerOrMeal, Region


@cache
def load_emission_factors() -> dict[str, dict[Region, float]]:
    return {
        c.name: {"us": c.emission_factor_us, "europe": c.emission_factor_europe}
        for c in categories()
    }


def get_emission_factor(category: str, region: Region = "us") -> float:
    return load_emission_factors()[category][region]


def calculate_emissions(df: pd.DataFrame, region: Region = "us") -> pd.DataFrame:
    """Add each row's ``emission_factor_used`` and ``emissions_kg_co2e``."""
    out = df.copy()
    factors = {name: by_region[region] for name, by_region in load_emission_factors().items()}
    out["emission_factor_used"] = out["category"].map(factors)
    out["emissions_kg_co2e"] = out["kilos_total"] * out["emission_factor_used"]
    return out


def calculate_emissions_summary(df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate total emissions per category."""
    summary = (
        df.groupby("category", dropna=False)["emissions_kg_co2e"]
        .sum(min_count=1)
        .reset_index()
        .rename(columns={"emissions_kg_co2e": "total_kg_co2e"})
    )
    total = summary["total_kg_co2e"].sum()
    summary["pct_of_total"] = ((summary["total_kg_co2e"] / total) * 100).round(1)
    return summary.sort_values("total_kg_co2e", ascending=False).reset_index(drop=True)


def _round_to_significant_figures(values: pd.Series, significant_figures: int) -> pd.Series:
    """Round each value to a fixed number of significant figures.

    Zero and NaN pass through unchanged; a plain decimal round would instead floor a small
    category's per-diner emissions to ``0.0``, which reads as a bug beside a category the
    site did buy.
    """
    magnitude = pd.Series(np.floor(np.log10(values.abs().where(values != 0))), index=values.index)
    decimals = (significant_figures - 1 - magnitude).fillna(0).astype(int)
    scale = 10.0**decimals
    return (values * scale).round() / scale


def calculate_emissions_per_diner_meal(
    emissions_summary: pd.DataFrame,
    total_diner_meals: float,
    diner_or_meal: DinerOrMeal,
) -> pd.DataFrame:
    """Add a ``kg_co2e_per_diner`` (or ``kg_co2e_per_meal``) column to an emissions summary."""
    if not total_diner_meals > 0:
        raise ValueError(f"The {diner_or_meal} count must be positive, got {total_diner_meals}")
    per_diner_meal = emissions_summary["total_kg_co2e"] / total_diner_meals
    return emissions_summary.assign(
        **{f"kg_co2e_per_{diner_or_meal}": _round_to_significant_figures(per_diner_meal, 3)}
    )
