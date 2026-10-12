"""Canonical aggregation functions for food-report generation."""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

import pandas as pd

from gbd_foodservice_insights.categories import (
    animal_product_categories,
    category_names,
    plant_protein_categories,
    protein_categories,
)
from gbd_foodservice_insights.emissions import get_emission_factor
from gbd_foodservice_insights.report.metric import KILOS
from gbd_foodservice_insights.report.schema import DinerOrMeal, Region

_RUMINANT_SWAP_SOURCE_CATEGORIES = (
    "Beef and Buffalo Meat",
    "Lamb/mutton & goat meat",
)
_RUMINANT_SWAP_TARGET_CATEGORY = "Legumes"
_DEFAULT_RUMINANT_SWAP_LEVELS = (0.10, 0.25, 0.50, 1.00)
_MILK_SWAP_SOURCE_CATEGORIES = ("Milk (Cow's milk)",)
_MILK_SWAP_TARGET_CATEGORY = "Oat Milk"
_DEFAULT_MILK_SWAP_LEVELS = (0.10, 0.20, 0.50, 1.00)


@dataclass(frozen=True)
class AnimalEmissionsConcentration:
    """How much of the animal-product emissions its biggest emitters account for."""

    # Largest emitter first.
    top_products: tuple[str, ...]
    top_products_kg_co2e: float
    total_animal_kg_co2e: float

    @property
    def share_pct(self) -> float:
        return self.top_products_kg_co2e / self.total_animal_kg_co2e * 100


@dataclass(frozen=True)
class PlantAnimalSplit:
    # Percentages are rounded to one decimal, the precision every consumer shows.
    plant_pct: float
    animal_pct: float
    # In the report's metric: kilos or servings.
    plant_total: float
    animal_total: float
    # `month_year`, `plant`, `animal`, and `plant_pct`, which is NaN in a month totalling 0.
    monthly: pd.DataFrame


@dataclass(frozen=True)
class PlantProteinShare:
    # Rounded to one decimal, the precision every consumer shows.
    plant_protein_pct: float
    # In the report's metric: kilos or servings.
    plant_protein_total: float
    protein_total: float
    # `month_year`, `plant_protein_metric`, `total_protein_metric`, and `plant_protein_pct`,
    # which is NaN in a month whose protein totals 0.
    monthly: pd.DataFrame


@dataclass(frozen=True)
class Aggregation:
    monthly_product: pd.DataFrame
    # Also each (month, category)'s `emissions_kg_co2e`.
    monthly_category: pd.DataFrame
    template: pd.DataFrame
    overall_drivers: pd.DataFrame
    category_drivers: pd.DataFrame
    # Each is `None` when the data has nothing to show: no animal rows, or no ruminant or cow's
    # milk rows to swap.
    animal_emissions_intensity: pd.DataFrame | None
    animal_emissions_concentration: AnimalEmissionsConcentration | None
    substitution_scenarios: pd.DataFrame | None


def aggregate_data(
    df: pd.DataFrame, group_by: Literal["product", "category"], metric: str
) -> pd.DataFrame:
    """Sum ``metric`` by month and group, leaving an all-missing group missing."""
    return (
        df.groupby(["month_year", group_by], dropna=False)[[metric]].sum(min_count=1).reset_index()
    )


def monthly_totals(df: pd.DataFrame, metric: str) -> pd.Series:
    """Sum ``metric`` by month, leaving an all-missing month missing."""
    return df.groupby("month_year", dropna=False)[metric].sum(min_count=1)


def create_template_data(monthly_category_data: pd.DataFrame, metric: str) -> pd.DataFrame:
    """Create category x month pivot table for report template."""
    tbl = (
        monthly_category_data.pivot_table(
            index="category",
            columns="month_year",
            values=metric,
            aggfunc=lambda values: values.sum(min_count=1),
            margins=True,
            margins_name="total",
            dropna=False,
        )
        .reindex([*category_names(), "total"], fill_value=0)
        .round(3)
    )
    return tbl


def _safe_percentage(numerator: pd.Series, denominator: pd.Series) -> pd.Series:
    """Every part of a total of 0 is 0% of it, since a zero-weight line is ordinary data."""
    pct = (numerator / denominator * 100).where(denominator != 0, 0.0)
    return pct.round(1)


def identify_category_drivers(
    one_big_table: pd.DataFrame,
    metric: str = "kilos_total",
    top_n: int = 5,
) -> pd.DataFrame:
    """Identify top N product drivers within each category."""
    product_cat = (
        one_big_table.groupby(["category", "product"], dropna=False)[metric]
        .sum(min_count=1)
        .reset_index()
    )
    cat_totals = (
        one_big_table.groupby("category", dropna=False)[metric]
        .sum(min_count=1)
        .reset_index()
        .rename(columns={metric: f"{metric}_in_category"})
    )

    product_cat = product_cat.merge(cat_totals, on="category", how="left")
    product_cat["percentage"] = _safe_percentage(
        product_cat[metric], product_cat[f"{metric}_in_category"]
    )

    top_products = (
        product_cat.sort_values(["category", metric], ascending=[True, False])
        .groupby("category", dropna=False)
        .head(top_n)
        .sort_values(["category", metric], ascending=[True, False])
    )
    return top_products


def identify_overall_drivers(
    one_big_table: pd.DataFrame,
    metric: str = "kilos_total",
    top_n: int = 10,
) -> pd.DataFrame:
    """Identify top N overall product drivers."""
    product_totals = (
        one_big_table.groupby("product", dropna=False)[metric].sum(min_count=1).reset_index()
    )
    overall = one_big_table[metric].sum(min_count=1)
    product_totals["percentage"] = _safe_percentage(
        product_totals[metric], pd.Series(overall, index=product_totals.index)
    )

    top_overall = product_totals.sort_values(metric, ascending=False).head(top_n)
    return top_overall


def calculate_plant_animal_split(
    df: pd.DataFrame,
    metric_col: str = "kilos_total",
) -> PlantAnimalSplit:
    """Counts every row not in an animal category as plant, so `df` must hold only GBD
    categories, as `build_food_report`'s validation ensures."""
    classified = df.assign(
        _group=df["category"]
        .isin(animal_product_categories())
        .map({True: "animal", False: "plant"})
    )
    totals = classified.groupby("_group")[metric_col].sum()
    plant_total = float(totals.get("plant", 0.0))
    animal_total = float(totals.get("animal", 0.0))
    grand_total = plant_total + animal_total
    if grand_total == 0:
        raise ValueError(f"Every row has a {metric_col} of 0, so there is nothing to split.")

    monthly = (
        classified.groupby(["month_year", "_group"], dropna=False)[metric_col]
        .sum(min_count=1)
        .unstack(fill_value=0)
        .rename_axis(columns=None)
        .reset_index()
    )
    # Ensure both columns exist even if one group has no data
    for col in ("plant", "animal"):
        if col not in monthly.columns:
            monthly[col] = 0.0
    monthly["total"] = monthly["plant"] + monthly["animal"]
    monthly["plant_pct"] = (
        monthly["plant"] / monthly["total"].replace({0: float("nan")}) * 100
    ).round(1)

    return PlantAnimalSplit(
        plant_pct=round(plant_total / grand_total * 100, 1),
        animal_pct=round(animal_total / grand_total * 100, 1),
        plant_total=plant_total,
        animal_total=animal_total,
        monthly=monthly[["month_year", "plant", "animal", "plant_pct"]],
    )


def calculate_plant_protein_share(
    df: pd.DataFrame,
    metric_col: str = "kilos_total",
) -> PlantProteinShare | None:
    """Calculate the plant-protein share within protein categories only.

    This exists to give the report a cleaner protein-transition headline than
    the broader plant-vs-animal split by restricting both the numerator and
    denominator to categories that meaningfully contribute protein.

    Returns ``None`` if there is no protein volume in the selected metric.
    """
    classified = df[df["category"].isin(protein_categories())].copy()
    classified["_is_plant_protein"] = classified["category"].isin(plant_protein_categories())
    protein_total = float(classified[metric_col].sum())
    if protein_total == 0:
        return None

    plant_protein_total = float(classified.loc[classified["_is_plant_protein"], metric_col].sum())

    monthly = (
        classified.groupby(["month_year", "_is_plant_protein"], dropna=False)[metric_col]
        .sum(min_count=1)
        .unstack(fill_value=0)
        .rename_axis(columns=None)
        .reset_index()
        .rename(
            columns={
                False: "animal_or_other_protein_metric",
                True: "plant_protein_metric",
            }
        )
    )
    if "plant_protein_metric" not in monthly.columns:
        monthly["plant_protein_metric"] = 0.0
    if "animal_or_other_protein_metric" not in monthly.columns:
        monthly["animal_or_other_protein_metric"] = 0.0
    monthly["total_protein_metric"] = (
        monthly["plant_protein_metric"] + monthly["animal_or_other_protein_metric"]
    )
    monthly["plant_protein_pct"] = (
        monthly["plant_protein_metric"]
        / monthly["total_protein_metric"].replace({0: float("nan")})
        * 100
    ).round(1)

    return PlantProteinShare(
        plant_protein_pct=round(plant_protein_total / protein_total * 100, 1),
        plant_protein_total=plant_protein_total,
        protein_total=protein_total,
        monthly=monthly[
            ["month_year", "plant_protein_metric", "total_protein_metric", "plant_protein_pct"]
        ],
    )


def summarize_animal_emissions_intensity(df: pd.DataFrame) -> pd.DataFrame:
    """Summarize animal-category weight, emissions, and emissions intensity.

    This exists so procurement reports can show which animal categories are
    high-impact because they combine meaningful purchased volume with a high
    carbon intensity per kilogram of food.
    """
    animal_rows = df[df["category"].isin(animal_product_categories())]
    if animal_rows.empty:
        return pd.DataFrame(
            columns=["category", "kilos_total", "total_kg_co2e", "kg_co2e_per_kg_food"]
        )

    summary = (
        animal_rows.groupby("category", dropna=False)[["kilos_total", "emissions_kg_co2e"]]
        .sum(min_count=1)
        .reset_index()
        .rename(columns={"emissions_kg_co2e": "total_kg_co2e"})
    )
    summary["kg_co2e_per_kg_food"] = summary["total_kg_co2e"] / summary["kilos_total"].mask(
        summary["kilos_total"] == 0
    )

    return summary.sort_values("total_kg_co2e", ascending=False).reset_index(drop=True)


def calculate_animal_emissions_concentration(
    df: pd.DataFrame, *, top_n: int
) -> AnimalEmissionsConcentration | None:
    """Summarize how concentrated animal-product emissions are in a few products.

    This exists to help clients focus effort on the small number of animal
    products that drive the largest share of their animal-product emissions.
    """
    animal_rows = df[df["category"].isin(animal_product_categories())]
    if animal_rows.empty:
        return None

    product_emissions = (
        animal_rows.groupby("product", dropna=False)["emissions_kg_co2e"]
        .sum(min_count=1)
        .dropna()
        .sort_values(ascending=False, kind="stable")
    )
    total_animal_emissions = float(product_emissions.sum())
    if total_animal_emissions <= 0:
        return None

    top_products = product_emissions.head(top_n)
    return AnimalEmissionsConcentration(
        top_products=tuple(
            "Missing product name" if pd.isna(product) else str(product)
            for product in top_products.index
        ),
        top_products_kg_co2e=float(top_products.sum()),
        total_animal_kg_co2e=total_animal_emissions,
    )


def calculate_category_swap_scenarios(
    df: pd.DataFrame,
    *,
    scenario_label_template: str,
    source_categories: tuple[str, ...],
    replacement_category: str,
    region: Region = "us",
    substitution_levels: tuple[float, ...],
) -> pd.DataFrame:
    """Calculate avoidable emissions from replacing one category group with another."""
    columns = [
        "scenario",
        "substitution_pct",
        "source_categories",
        "replacement_category",
        "baseline_source_weight_kg",
        "baseline_source_emissions_kg_co2e",
        "replaced_weight_kg",
        "remaining_source_weight_kg",
        "replacement_weight_kg",
        "replacement_emission_factor_kg_co2e_per_kg",
        "projected_emissions_kg_co2e",
        "avoidable_kg_co2e",
        "institution_emissions_avoided_pct",
    ]
    ruminant_rows = df.loc[df["category"].isin(source_categories)].copy()
    if ruminant_rows.empty:
        return pd.DataFrame(columns=columns)

    replacement_factor = get_emission_factor(replacement_category, region=region)
    factor_lookup = {
        category_name: get_emission_factor(category_name, region=region)
        for category_name in source_categories
    }
    ruminant_rows["_source_emission_factor"] = ruminant_rows["category"].map(factor_lookup)

    ruminant_rows["_baseline_emissions_kg_co2e"] = (
        ruminant_rows["kilos_total"] * ruminant_rows["_source_emission_factor"]
    )
    baseline_weight = float(ruminant_rows["kilos_total"].sum())
    if baseline_weight <= 0:
        return pd.DataFrame(columns=columns)

    baseline_emissions = float(ruminant_rows["_baseline_emissions_kg_co2e"].sum())
    average_ruminant_factor = baseline_emissions / baseline_weight
    institution_total_emissions = float(df["emissions_kg_co2e"].sum())
    source_categories_present = ", ".join(sorted(ruminant_rows["category"].unique()))

    scenario_rows: list[dict[str, Any]] = []
    for substitution_level in substitution_levels:
        replaced_weight = baseline_weight * substitution_level
        projected_emissions = baseline_emissions - replaced_weight * (
            average_ruminant_factor - float(replacement_factor)
        )
        avoidable_emissions = baseline_emissions - projected_emissions
        scenario_rows.append(
            {
                "scenario": scenario_label_template.format(level=substitution_level),
                "substitution_pct": round(substitution_level * 100, 1),
                "source_categories": source_categories_present,
                "replacement_category": replacement_category,
                "baseline_source_weight_kg": round(baseline_weight, 3),
                "baseline_source_emissions_kg_co2e": round(baseline_emissions, 3),
                "replaced_weight_kg": round(replaced_weight, 3),
                "remaining_source_weight_kg": round(baseline_weight - replaced_weight, 3),
                "replacement_weight_kg": round(replaced_weight, 3),
                "replacement_emission_factor_kg_co2e_per_kg": round(float(replacement_factor), 3),
                "projected_emissions_kg_co2e": round(projected_emissions, 3),
                "avoidable_kg_co2e": round(avoidable_emissions, 3),
                "institution_emissions_avoided_pct": round(
                    (avoidable_emissions / institution_total_emissions) * 100
                    if institution_total_emissions > 0
                    else 0.0,
                    2,
                ),
            }
        )

    return pd.DataFrame(scenario_rows, columns=columns)


def calculate_ruminant_legume_swap_scenarios(
    df: pd.DataFrame,
    *,
    region: Region = "us",
    substitution_levels: tuple[float, ...] = _DEFAULT_RUMINANT_SWAP_LEVELS,
) -> pd.DataFrame:
    """Calculate avoidable emissions from replacing ruminant meat with legumes."""
    return calculate_category_swap_scenarios(
        df,
        scenario_label_template="{level:.0%} ruminant-to-legume swap",
        source_categories=_RUMINANT_SWAP_SOURCE_CATEGORIES,
        replacement_category=_RUMINANT_SWAP_TARGET_CATEGORY,
        region=region,
        substitution_levels=substitution_levels,
    )


def calculate_milk_oat_swap_scenarios(
    df: pd.DataFrame,
    *,
    region: Region = "us",
    substitution_levels: tuple[float, ...] = _DEFAULT_MILK_SWAP_LEVELS,
) -> pd.DataFrame:
    """Calculate avoidable emissions from replacing cow's milk with oat milk."""
    return calculate_category_swap_scenarios(
        df,
        scenario_label_template="{level:.0%} cow's-milk-to-oat-milk swap",
        source_categories=_MILK_SWAP_SOURCE_CATEGORIES,
        replacement_category=_MILK_SWAP_TARGET_CATEGORY,
        region=region,
        substitution_levels=substitution_levels,
    )


def run_aggregation_pipeline(
    df: pd.DataFrame,
    diner_meal_mapping: Mapping[pd.Period, float],
    top_n: int = 5,
    *,
    region: Region = "us",
    diner_or_meal: DinerOrMeal,
) -> Aggregation:
    """Run the full report aggregation pipeline on a ``df`` that already carries
    ``emissions_kg_co2e``."""

    def monthly(group_by: Literal["product", "category"]) -> pd.DataFrame:
        agg = aggregate_data(df, group_by=group_by, metric=KILOS.column)
        return agg.assign(
            **{
                KILOS.per_head(diner_or_meal): agg[KILOS.column]
                / agg["month_year"].map(diner_meal_mapping)
            }
        )

    monthly_category_data = monthly("category")
    return Aggregation(
        monthly_product=monthly("product"),
        monthly_category=_attach_monthly_category_emissions(monthly_category_data, df),
        template=create_template_data(monthly_category_data, KILOS.column),
        overall_drivers=identify_overall_drivers(df, metric=KILOS.column, top_n=top_n),
        category_drivers=identify_category_drivers(df, metric=KILOS.column, top_n=top_n),
        animal_emissions_intensity=_none_if_empty(summarize_animal_emissions_intensity(df)),
        animal_emissions_concentration=calculate_animal_emissions_concentration(df, top_n=top_n),
        substitution_scenarios=_none_if_empty(_substitution_scenarios(df, region=region)),
    )


def _substitution_scenarios(df: pd.DataFrame, *, region: Region) -> pd.DataFrame:
    return pd.concat(
        [
            calculate_ruminant_legume_swap_scenarios(df, region=region),
            calculate_milk_oat_swap_scenarios(df, region=region),
        ],
        ignore_index=True,
    )


def _attach_monthly_category_emissions(monthly_cat: pd.DataFrame, df: pd.DataFrame) -> pd.DataFrame:
    """Add each (month, category) row's own ``emissions_kg_co2e`` total."""
    # Charts sum this column per month. Joining on month alone would copy the month's total onto
    # every category row, multiplying the charted total by the number of categories.
    keys = ["month_year", "category"]
    category_emissions = (
        df.groupby(keys, dropna=False)["emissions_kg_co2e"].sum(min_count=1).reset_index()
    )
    return monthly_cat.merge(category_emissions, on=keys, how="left", validate="one_to_one")


def _none_if_empty(table: pd.DataFrame) -> pd.DataFrame | None:
    return None if table.empty else table
