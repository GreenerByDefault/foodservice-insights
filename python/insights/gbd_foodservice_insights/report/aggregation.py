"""Canonical aggregation functions for food-report generation."""

from __future__ import annotations

from typing import Any

import pandas as pd

from gbd_foodservice_insights.categories import (
    get_animal_product_categories,
    get_GBD_categories,
    get_plant_based_categories,
    get_plant_protein_categories,
    get_protein_categories,
)
from gbd_foodservice_insights.emissions import get_emission_factor
from gbd_foodservice_insights.plotting_utils import format_percentage_column
from gbd_foodservice_insights.report.schema import per_diner_metric_name
from gbd_foodservice_insights.report.utils import (
    compute_month_alignment,
    normalize_diner_meal_mapping,
)

_RUMINANT_SWAP_SOURCE_CATEGORIES = (
    "beef and buffalo meat",
    "lamb/mutton & goat meat",
)
_RUMINANT_SWAP_TARGET_CATEGORY = "Legumes"
_DEFAULT_RUMINANT_SWAP_LEVELS = (0.10, 0.25, 0.50, 1.00)
_MILK_SWAP_SOURCE_CATEGORIES = ("milk (cow's milk)",)
_MILK_SWAP_TARGET_CATEGORY = "Oat Milk"
_DEFAULT_MILK_SWAP_LEVELS = (0.10, 0.20, 0.50, 1.00)


def _normalize_categories_to_canonical_labels(
    category_series: pd.Series,
) -> pd.Series:
    """Map known category labels back to canonical GBD capitalization."""
    canonical_lookup = {category.lower(): category for category in get_GBD_categories()}

    return category_series.map(
        lambda value: (
            canonical_lookup.get(str(value).strip().lower(), str(value).strip())
            if pd.notna(value)
            else value
        )
    )


def aggregate_data(
    df: pd.DataFrame,
    group_by: str = "product",
    diner_meal_mapping: dict[Any, Any] | None = None,
    per_diner_meal: bool = False,
    metrics: list[str] | str = "kilos_total",
    timescale: str = "month_year",
    *,
    strict_diner_meal_coverage: bool = True,
) -> pd.DataFrame:
    """Aggregate metrics by timescale and group.

    Uses ``sum(min_count=1)`` to preserve all-missing groups as missing values.
    """
    if timescale not in {"month_year", "period"}:
        raise ValueError("timescale must be 'month_year' or 'period'.")
    if timescale not in df.columns:
        raise ValueError(f"'{timescale}' column not found in DataFrame.")

    if group_by not in {"product", "category"}:
        raise ValueError("group_by must be 'product' or 'category'.")
    if group_by not in df.columns:
        raise ValueError(f"'{group_by}' column not found in DataFrame.")

    metric_list = [metrics] if isinstance(metrics, str) else list(metrics)
    if not metric_list:
        raise ValueError("metrics must contain at least one metric column.")

    for metric_name in metric_list:
        if metric_name not in df.columns:
            raise ValueError(f"Metric column '{metric_name}' not found in DataFrame.")

    agg = (
        df.groupby([timescale, group_by], dropna=False)[metric_list].sum(min_count=1).reset_index()
    )

    if not per_diner_meal:
        return agg

    if diner_meal_mapping is None:
        raise ValueError("diner_meal_mapping is required when per_diner_meal=True")

    dm_mapping = normalize_diner_meal_mapping(diner_meal_mapping)
    alignment = compute_month_alignment(agg[timescale].dropna().unique(), dm_mapping.keys())
    missing_months = alignment["missing_in_mapping"]
    invalid_counts = [month for month, value in dm_mapping.items() if value <= 0]

    if strict_diner_meal_coverage and (missing_months or invalid_counts):
        details: list[str] = []
        if missing_months:
            details.append(f"missing months in diner_meal_mapping: {missing_months}")
        if invalid_counts:
            details.append(f"non-positive diner-meal counts: {invalid_counts}")
        raise ValueError("Cannot compute per-diner metrics: " + "; ".join(details))

    denom = agg[timescale].map(dm_mapping)

    for metric_name in metric_list:
        per_dm_col = per_diner_metric_name(metric_name)
        agg[per_dm_col] = agg[metric_name] / denom

    return agg


def create_template_data(monthly_category_data: pd.DataFrame, metric: str) -> pd.DataFrame:
    """Create category x month pivot table for report template."""
    if metric not in monthly_category_data.columns:
        raise KeyError(metric)

    canonical_categories = get_GBD_categories()

    normalized = monthly_category_data.copy()
    normalized["category"] = _normalize_categories_to_canonical_labels(normalized["category"])

    tbl = (
        normalized.pivot_table(
            index="category",
            columns="month_year",
            values=metric,
            aggfunc=lambda values: values.sum(min_count=1),
            margins=True,
            margins_name="total",
            dropna=False,
        )
        .reindex([*canonical_categories, "total"], fill_value=0)
        .round(3)
    )
    return tbl


def _safe_percentage(numerator: pd.Series, denominator: pd.Series) -> pd.Series:
    """Compute percentage with zero/NaN-safe behavior."""
    pct = (numerator / denominator.replace({0: pd.NA})) * 100
    return pct.astype(float).round(1)


def identify_category_drivers(
    one_big_table: pd.DataFrame,
    metric: str = "kilos_total",
    top_n: int = 5,
) -> pd.DataFrame:
    """Identify top N product drivers within each category."""
    if metric not in one_big_table.columns:
        raise ValueError(f"Metric column '{metric}' not found in DataFrame.")

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
    return format_percentage_column(top_products)


def identify_overall_drivers(
    one_big_table: pd.DataFrame,
    metric: str = "kilos_total",
    top_n: int = 10,
) -> pd.DataFrame:
    """Identify top N overall product drivers."""
    if metric not in one_big_table.columns:
        raise ValueError(f"Metric column '{metric}' not found in DataFrame.")

    product_totals = (
        one_big_table.groupby("product", dropna=False)[metric].sum(min_count=1).reset_index()
    )
    overall = one_big_table[metric].sum(min_count=1)

    if pd.isna(overall) or overall == 0:
        product_totals["percentage"] = 0.0
    else:
        product_totals["percentage"] = _safe_percentage(
            product_totals[metric], pd.Series(overall, index=product_totals.index)
        )

    top_overall = product_totals.sort_values(metric, ascending=False).head(top_n)
    return format_percentage_column(top_overall)


def category_highest_vs_lowest_months(
    monthly_category_data: pd.DataFrame,
    metric_col: str = "kilos per diner-meal",
) -> pd.DataFrame:
    """Calculate highest-to-lowest month ratio per category."""
    if metric_col not in monthly_category_data.columns:
        raise ValueError(f"Metric column '{metric_col}' not found in DataFrame.")

    results: list[dict[str, Any]] = []
    for category, cat_data in monthly_category_data.groupby("category", dropna=False):
        values = cat_data[metric_col].dropna()
        if values.empty:
            continue
        max_val = values.max()
        min_val = values.min()
        if min_val == 0:  # noqa: SIM108  # the nested conditional expression reads worse
            times_higher = float("inf") if max_val > 0 else 1.0
        else:
            times_higher = max_val / min_val

        if times_higher >= 2:
            results.append({"category": category, "times_higher": times_higher})

    if not results:
        return pd.DataFrame(columns=["category", "times_higher"])

    return pd.DataFrame(results).sort_values("times_higher", ascending=False).round(1)


def calculate_plant_animal_split(
    df: pd.DataFrame,
    metric_col: str = "kilos_total",
) -> dict[str, Any] | None:
    """Calculate the plant vs. animal split of a food metric.

    Uses GBD category metadata to classify each row as plant-based or
    animal-based, then sums the metric column for each group.

    Returns a dict with::

        {
            "plant_pct": float,   # % of total that is plant-based
            "animal_pct": float,  # % of total that is animal-based
            "plant_kg": float,
            "animal_kg": float,
            "monthly": pd.DataFrame,   # columns: month_year, plant, animal
        }

    Returns ``None`` if the required columns are missing or the total is zero.
    """
    if metric_col not in df.columns or "category" not in df.columns:
        return None

    animal_cats = set(c.lower() for c in get_animal_product_categories())
    plant_cats = set(c.lower() for c in get_plant_based_categories())

    df_copy = df.copy()
    df_copy["_category_lower"] = df_copy["category"].astype(str).str.lower()
    df_copy["_group"] = "other"
    df_copy.loc[df_copy["_category_lower"].isin(animal_cats), "_group"] = "animal"
    df_copy.loc[df_copy["_category_lower"].isin(plant_cats), "_group"] = "plant"

    # Filter to only plant + animal rows for the split calculation
    classified = df_copy[df_copy["_group"].isin(["plant", "animal"])].copy()
    if classified.empty:
        return None

    totals = classified.groupby("_group")[metric_col].sum(min_count=1)
    plant_kg = float(totals.get("plant", 0.0) or 0.0)
    animal_kg = float(totals.get("animal", 0.0) or 0.0)
    grand_total = plant_kg + animal_kg

    if grand_total == 0:
        return None

    plant_pct = round(plant_kg / grand_total * 100, 1)
    animal_pct = round(animal_kg / grand_total * 100, 1)

    # Monthly breakdown (for trend chart)
    monthly: pd.DataFrame | None = None
    if "month_year" in df_copy.columns:
        monthly_raw = (
            classified.groupby(["month_year", "_group"], dropna=False)[metric_col]
            .sum(min_count=1)
            .unstack(fill_value=0)
            .reset_index()
        )
        # Ensure both columns exist even if one group has no data
        for col in ("plant", "animal"):
            if col not in monthly_raw.columns:
                monthly_raw[col] = 0.0
        monthly_raw["total"] = monthly_raw["plant"] + monthly_raw["animal"]
        monthly_raw["plant_pct"] = (
            monthly_raw["plant"] / monthly_raw["total"].replace({0: float("nan")}) * 100
        ).round(1)
        monthly = monthly_raw[["month_year", "plant", "animal", "plant_pct"]]

    return {
        "plant_pct": plant_pct,
        "animal_pct": animal_pct,
        "plant_kg": plant_kg,
        "animal_kg": animal_kg,
        "monthly": monthly,
    }


def calculate_plant_protein_share(
    df: pd.DataFrame,
    metric_col: str = "kilos_total",
) -> dict[str, Any] | None:
    """Calculate the plant-protein share within protein categories only.

    This exists to give the report a cleaner protein-transition headline than
    the broader plant-vs-animal split by restricting both the numerator and
    denominator to categories that meaningfully contribute protein.

    Returns a dict with::

        {
            "plant_protein_pct": float,
            "plant_protein_total": float,
            "total_protein_metric": float,
            "monthly": pd.DataFrame,  # month_year, plant_protein_metric, total_protein_metric,
            # plant_protein_pct
        }

    Returns ``None`` if required columns are missing or there is no protein
    volume in the selected metric.
    """
    if metric_col not in df.columns or "category" not in df.columns:
        return None

    protein_cats = set(category.lower() for category in get_protein_categories())
    plant_protein_cats = set(category.lower() for category in get_plant_protein_categories())

    classified = df.copy()
    classified["_category_lower"] = classified["category"].astype(str).str.lower()
    classified = classified[classified["_category_lower"].isin(protein_cats)].copy()
    if classified.empty:
        return None

    classified["_is_plant_protein"] = classified["_category_lower"].isin(plant_protein_cats)
    total_protein_metric = float(classified[metric_col].sum(min_count=1) or 0.0)
    if total_protein_metric == 0:
        return None

    plant_protein_total = float(
        classified.loc[classified["_is_plant_protein"], metric_col].sum(min_count=1) or 0.0
    )
    plant_protein_pct = round(plant_protein_total / total_protein_metric * 100, 1)

    monthly: pd.DataFrame | None = None
    if "month_year" in classified.columns:
        monthly = (
            classified.groupby(["month_year", "_is_plant_protein"], dropna=False)[metric_col]
            .sum(min_count=1)
            .unstack(fill_value=0)
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
        monthly = monthly[
            ["month_year", "plant_protein_metric", "total_protein_metric", "plant_protein_pct"]
        ]

    return {
        "plant_protein_pct": plant_protein_pct,
        "plant_protein_total": plant_protein_total,
        "total_protein_metric": total_protein_metric,
        "monthly": monthly,
    }


def summarize_animal_emissions_intensity(
    df: pd.DataFrame,
    *,
    weight_col: str = "kilos_total",
    category_col: str = "category",
    emissions_col: str = "emissions_kg_co2e",
) -> pd.DataFrame:
    """Summarize animal-category weight, emissions, and emissions intensity.

    This exists so procurement reports can show which animal categories are
    high-impact because they combine meaningful purchased volume with a high
    carbon intensity per kilogram of food.
    """
    required_columns = {weight_col, category_col, emissions_col}
    output_columns = [category_col, weight_col, "total_kg_co2e", "kg_co2e_per_kg_food"]
    if not required_columns.issubset(df.columns):
        return pd.DataFrame(columns=output_columns)

    animal_cats = {category.lower() for category in get_animal_product_categories()}
    animal_rows = df[df[category_col].astype(str).str.lower().isin(animal_cats)].copy()
    if animal_rows.empty:
        return pd.DataFrame(columns=output_columns)
    animal_rows[category_col] = _normalize_categories_to_canonical_labels(animal_rows[category_col])

    summary = (
        animal_rows.groupby(category_col, dropna=False)[[weight_col, emissions_col]]
        .sum(min_count=1)
        .reset_index()
        .rename(columns={emissions_col: "total_kg_co2e"})
    )
    summary["kg_co2e_per_kg_food"] = (
        summary["total_kg_co2e"] / summary[weight_col].replace({0: pd.NA})
    ).astype(float)

    return summary.sort_values("total_kg_co2e", ascending=False).reset_index(drop=True)


def calculate_animal_emissions_concentration(
    df: pd.DataFrame,
    *,
    product_col: str = "product",
    category_col: str = "category",
    emissions_col: str = "emissions_kg_co2e",
    top_n: int = 5,
) -> pd.DataFrame:
    """Summarize how concentrated animal-product emissions are in a few products.

    This exists to help clients focus effort on the small number of animal
    products that drive the largest share of their animal-product emissions.
    """
    output_columns = [
        "KPI",
        "Value",
        "Unit",
        "Denominator",
        "Top products",
        "Top product emissions (kg CO2e)",
        "Total animal emissions (kg CO2e)",
    ]
    required_columns = {product_col, category_col, emissions_col}
    if not required_columns.issubset(df.columns):
        return pd.DataFrame(columns=output_columns)

    animal_categories = {category.lower() for category in get_animal_product_categories()}
    animal_rows = df[df[category_col].astype(str).str.lower().isin(animal_categories)].copy()
    if animal_rows.empty:
        return pd.DataFrame(columns=output_columns)

    product_emissions = (
        animal_rows.groupby(product_col, dropna=False)[emissions_col]
        .sum(min_count=1)
        .reset_index()
        .rename(columns={emissions_col: "animal_product_emissions_kg_co2e"})
    )
    product_emissions = product_emissions[
        product_emissions["animal_product_emissions_kg_co2e"].notna()
    ].copy()
    if product_emissions.empty:
        return pd.DataFrame(columns=output_columns)

    product_emissions = product_emissions.sort_values(
        "animal_product_emissions_kg_co2e",
        ascending=False,
        kind="stable",
    ).reset_index(drop=True)

    total_animal_emissions = float(
        product_emissions["animal_product_emissions_kg_co2e"].sum(min_count=1) or 0.0
    )
    if total_animal_emissions <= 0:
        return pd.DataFrame(columns=output_columns)

    top_products = product_emissions.head(top_n).copy()
    top_products_emissions = float(
        top_products["animal_product_emissions_kg_co2e"].sum(min_count=1) or 0.0
    )
    n_products_used = len(top_products)
    top_products_list = " | ".join(
        str(product) for product in top_products[product_col].fillna("Missing product name")
    )

    return pd.DataFrame(
        [
            {
                "KPI": f"Top {n_products_used} animal products share of animal-product emissions",
                "Value": round(top_products_emissions / total_animal_emissions * 100, 1),
                "Unit": "%",
                "Denominator": "Animal-product emissions only",
                "Top products": top_products_list,
                "Top product emissions (kg CO2e)": round(top_products_emissions, 1),
                "Total animal emissions (kg CO2e)": round(total_animal_emissions, 1),
            }
        ],
        columns=output_columns,
    )


def calculate_category_swap_scenarios(
    df: pd.DataFrame,
    *,
    scenario_label_template: str,
    source_categories: tuple[str, ...],
    replacement_category: str,
    weight_col: str = "kilos_total",
    category_col: str = "category",
    region: str = "us",
    substitution_levels: tuple[float, ...],
) -> pd.DataFrame:
    """Calculate avoidable emissions from replacing one category group with another."""
    columns = [
        "scenario",
        "substitution_pct",
        "source_categories",
        "replacement_category",
        "baseline_ruminant_weight_kg",
        "baseline_ruminant_emissions_kg_co2e",
        "replaced_weight_kg",
        "remaining_ruminant_weight_kg",
        "replacement_weight_kg",
        "replacement_emission_factor_kg_co2e_per_kg",
        "projected_emissions_kg_co2e",
        "avoidable_kg_co2e",
        "institution_emissions_avoided_pct",
    ]
    if weight_col not in df.columns or category_col not in df.columns:
        return pd.DataFrame(columns=columns)

    ruminant_rows = df.loc[df[category_col].astype(str).str.lower().isin(source_categories)].copy()
    if ruminant_rows.empty:
        return pd.DataFrame(columns=columns)

    replacement_factor = get_emission_factor(replacement_category, region=region)
    if replacement_factor is None:
        raise ValueError(
            f"No emission factor found for '{replacement_category}' in region '{region}'."
        )

    factor_lookup = {
        category_name: get_emission_factor(category_name, region=region)
        for category_name in ruminant_rows[category_col].dropna().astype(str).unique()
    }
    ruminant_rows["_source_emission_factor"] = (
        ruminant_rows[category_col].astype(str).map(factor_lookup)
    )
    missing_categories = sorted(
        ruminant_rows.loc[ruminant_rows["_source_emission_factor"].isna(), category_col]
        .dropna()
        .astype(str)
        .unique()
    )
    if missing_categories:
        raise ValueError(
            "Missing ruminant emission factors for categories: " + ", ".join(missing_categories)
        )

    ruminant_rows["_baseline_emissions_kg_co2e"] = ruminant_rows[weight_col].astype(
        float
    ) * ruminant_rows["_source_emission_factor"].astype(float)
    baseline_weight = float(ruminant_rows[weight_col].sum(min_count=1) or 0.0)
    if baseline_weight <= 0:
        return pd.DataFrame(columns=columns)

    baseline_emissions = float(ruminant_rows["_baseline_emissions_kg_co2e"].sum(min_count=1) or 0.0)
    average_ruminant_factor = baseline_emissions / baseline_weight
    institution_total_emissions = float(df["emissions_kg_co2e"].sum(min_count=1) or 0.0)
    source_categories = ", ".join(sorted(ruminant_rows[category_col].dropna().astype(str).unique()))

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
                "source_categories": source_categories,
                "replacement_category": replacement_category,
                "baseline_ruminant_weight_kg": round(baseline_weight, 3),
                "baseline_ruminant_emissions_kg_co2e": round(baseline_emissions, 3),
                "replaced_weight_kg": round(replaced_weight, 3),
                "remaining_ruminant_weight_kg": round(baseline_weight - replaced_weight, 3),
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
    weight_col: str = "kilos_total",
    category_col: str = "category",
    region: str = "us",
    substitution_levels: tuple[float, ...] = _DEFAULT_RUMINANT_SWAP_LEVELS,
) -> pd.DataFrame:
    """Calculate avoidable emissions from replacing ruminant meat with legumes."""
    return calculate_category_swap_scenarios(
        df,
        scenario_label_template="{level:.0%} ruminant-to-legume swap",
        source_categories=_RUMINANT_SWAP_SOURCE_CATEGORIES,
        replacement_category=_RUMINANT_SWAP_TARGET_CATEGORY,
        weight_col=weight_col,
        category_col=category_col,
        region=region,
        substitution_levels=substitution_levels,
    )


def calculate_milk_oat_swap_scenarios(
    df: pd.DataFrame,
    *,
    weight_col: str = "kilos_total",
    category_col: str = "category",
    region: str = "us",
    substitution_levels: tuple[float, ...] = _DEFAULT_MILK_SWAP_LEVELS,
) -> pd.DataFrame:
    """Calculate avoidable emissions from replacing cow's milk with oat milk."""
    return calculate_category_swap_scenarios(
        df,
        scenario_label_template="{level:.0%} cow's-milk-to-oat-milk swap",
        source_categories=_MILK_SWAP_SOURCE_CATEGORIES,
        replacement_category=_MILK_SWAP_TARGET_CATEGORY,
        weight_col=weight_col,
        category_col=category_col,
        region=region,
        substitution_levels=substitution_levels,
    )


def run_aggregation_pipeline(
    df: pd.DataFrame,
    diner_meal_mapping: dict[Any, Any],
    metric_total: str = "kilos_total",
    top_n: int = 5,
    *,
    strict_diner_meal_coverage: bool = True,
    region: str = "us",
) -> dict[str, Any]:
    """Run the full report aggregation pipeline."""
    metrics = [metric_total]

    monthly_product_data = aggregate_data(
        df,
        group_by="product",
        diner_meal_mapping=diner_meal_mapping,
        per_diner_meal=True,
        metrics=metrics,
        strict_diner_meal_coverage=strict_diner_meal_coverage,
    )

    monthly_category_data = aggregate_data(
        df,
        group_by="category",
        diner_meal_mapping=diner_meal_mapping,
        per_diner_meal=True,
        metrics=metrics,
        strict_diner_meal_coverage=strict_diner_meal_coverage,
    )

    template_data = create_template_data(monthly_category_data, metric_total)
    overall_drivers = identify_overall_drivers(df, metric=metric_total, top_n=top_n)
    category_drivers = identify_category_drivers(df, metric=metric_total, top_n=top_n)

    per_dm_col = per_diner_metric_name(metric_total)
    highest_lowest = category_highest_vs_lowest_months(monthly_category_data, metric_col=per_dm_col)
    animal_emissions_intensity = summarize_animal_emissions_intensity(
        df,
        weight_col=metric_total,
    )
    decision_kpis = calculate_animal_emissions_concentration(df, top_n=top_n)
    substitution_scenarios = pd.DataFrame()
    if metric_total == "kilos_total":
        ruminant_swap_scenarios = calculate_ruminant_legume_swap_scenarios(
            df,
            weight_col=metric_total,
            region=region,
        )
        milk_swap_scenarios = calculate_milk_oat_swap_scenarios(
            df,
            weight_col=metric_total,
            region=region,
        )
        substitution_scenarios = pd.concat(
            [ruminant_swap_scenarios, milk_swap_scenarios],
            ignore_index=True,
        )

    return {
        "monthly_product_data": monthly_product_data,
        "monthly_category_data": monthly_category_data,
        "template_data": template_data,
        "overall_drivers": overall_drivers,
        "category_drivers": category_drivers,
        "highest_lowest": highest_lowest,
        "animal_emissions_intensity": animal_emissions_intensity,
        "decision_kpis": decision_kpis,
        "substitution_scenarios": substitution_scenarios,
    }
