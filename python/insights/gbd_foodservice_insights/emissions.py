"""Emission factor lookup and carbon metric calculations."""

from __future__ import annotations

from typing import Any, Literal, overload

import pandas as pd

from gbd_foodservice_insights.categories import get_gbd_categories_metadata
from gbd_foodservice_insights.report.quality import make_finding
from gbd_foodservice_insights.report.schema import VALID_REGIONS, validate_region

_EMISSION_FACTORS: dict[str, dict[str, float | None]] | None = None


def load_emission_factors() -> dict[str, dict[str, float | None]]:
    """Load emission factors from category metadata and cache results."""
    global _EMISSION_FACTORS
    if _EMISSION_FACTORS is not None:
        return _EMISSION_FACTORS

    data = get_gbd_categories_metadata()
    _EMISSION_FACTORS = {}
    for item in data["categories"]:
        name = item["cool_food_pledge_name"]
        _EMISSION_FACTORS[name] = {
            "us": item.get("emission_factor_us"),
            "europe": item.get("emission_factor_europe"),
        }

    return _EMISSION_FACTORS


def get_available_regions() -> list[str]:
    """Return supported emission-factor regions."""
    return list(VALID_REGIONS)


def get_emission_factor(category: str, region: str = "us") -> float | None:
    """Look up the emission factor for a single category."""
    normalized_region = validate_region(region)
    ef_dict = load_emission_factors()

    if category in ef_dict:
        return ef_dict[category][normalized_region]

    category_lower = str(category).lower()
    for name, factors in ef_dict.items():
        if name.lower() == category_lower:
            return factors[normalized_region]

    return None


@overload
def calculate_emissions(
    df: pd.DataFrame,
    weight_col: str,
    category_col: str = "category",
    region: str = "us",
    *,
    return_findings: Literal[False] = False,
) -> pd.DataFrame: ...


@overload
def calculate_emissions(
    df: pd.DataFrame,
    weight_col: str,
    category_col: str = "category",
    region: str = "us",
    *,
    return_findings: Literal[True],
) -> tuple[pd.DataFrame, list[dict[str, Any]]]: ...


@overload
def calculate_emissions(
    df: pd.DataFrame,
    weight_col: str,
    category_col: str = "category",
    region: str = "us",
    *,
    return_findings: bool,
) -> pd.DataFrame | tuple[pd.DataFrame, list[dict[str, Any]]]: ...


def calculate_emissions(
    df: pd.DataFrame,
    weight_col: str,
    category_col: str = "category",
    region: str = "us",
    *,
    return_findings: bool = False,
) -> pd.DataFrame | tuple[pd.DataFrame, list[dict[str, Any]]]:
    """Multiply each row's weight by category emission factor.

    Returns DataFrame with columns:
    - ``emission_factor_used``
    - ``emissions_kg_co2e``

    When ``return_findings=True`` returns ``(df, findings)``.
    """
    normalized_region = validate_region(region)

    if weight_col not in df.columns:
        raise ValueError(f"Weight column '{weight_col}' not found in DataFrame.")
    if category_col not in df.columns:
        raise ValueError(f"Category column '{category_col}' not found in DataFrame.")

    out = df.copy()
    ef_dict = load_emission_factors()

    lower_lookup: dict[str, float | None] = {
        name.lower(): factors[normalized_region] for name, factors in ef_dict.items()
    }

    out["emission_factor_used"] = out[category_col].astype(str).str.lower().map(lower_lookup)

    out["emissions_kg_co2e"] = out[weight_col] * out["emission_factor_used"]

    findings: list[dict[str, Any]] = []
    unmatched_series = out.loc[out["emission_factor_used"].isna(), category_col]
    if len(unmatched_series) > 0:
        unmatched = sorted(str(value) for value in unmatched_series.dropna().unique())
        findings.append(
            make_finding(
                stage="emissions",
                category="unmatched_emission_factors",
                status="warning",
                message=(
                    "Some categories have no emission factor and produced missing emissions values."
                ),
                count=len(unmatched),
                sample_values=unmatched[:10],
            )
        )

    if return_findings:
        return out, findings
    return out


def calculate_emissions_summary(
    df: pd.DataFrame,
    category_col: str = "category",
    emissions_col: str = "emissions_kg_co2e",
) -> pd.DataFrame:
    """Aggregate total emissions per category."""
    if category_col not in df.columns:
        raise ValueError(f"Category column '{category_col}' not found in DataFrame.")
    if emissions_col not in df.columns:
        raise ValueError(f"Emissions column '{emissions_col}' not found in DataFrame.")

    summary = (
        df.groupby(category_col, dropna=False)[emissions_col]
        .sum(min_count=1)
        .reset_index()
        .rename(columns={emissions_col: "total_kg_co2e", category_col: "category"})
    )

    total = summary["total_kg_co2e"].sum(min_count=1)
    if pd.isna(total) or total == 0:
        summary["pct_of_total"] = 0.0
    else:
        summary["pct_of_total"] = ((summary["total_kg_co2e"] / total) * 100).round(1)

    return summary.sort_values("total_kg_co2e", ascending=False).reset_index(drop=True)


def calculate_emissions_per_diner_meal(
    emissions_summary: pd.DataFrame,
    total_diner_meals: float | None,
) -> pd.DataFrame:
    """Add ``kg_co2e_per_diner_meal`` column to an emissions summary."""
    out = emissions_summary.copy()
    if total_diner_meals and total_diner_meals > 0:
        out["kg_co2e_per_diner_meal"] = (out["total_kg_co2e"] / float(total_diner_meals)).round(4)
    else:
        out["kg_co2e_per_diner_meal"] = float("nan")
    return out
