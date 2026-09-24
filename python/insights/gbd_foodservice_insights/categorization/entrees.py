"""
Entree Detection
=================

All serving-mode entree classification logic: historical reuse,
Gemini Flash/Pro two-pass classification, normalization, serving-size
assignment, and review-sheet construction.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

import pandas as pd

from gbd_foodservice_insights.categories import get_GBD_categories
from gbd_foodservice_insights.categorization.cache import (
    ENTREE_LABEL_ENTREE,
    ENTREE_LABEL_SIDE_ADDON,
    ENTREE_LABEL_UNSURE,
    _first_non_empty_value,
    _normalize_entree_classification,
    _normalize_product_name,
    build_entree_cleaned_name_reuse_index,
    get_previously_classified_entrees,
)
from gbd_foodservice_insights.llm import call_gemini_api, get_gemini_model
from gbd_foodservice_insights.llm_prompts import load_prompt
from gbd_foodservice_insights.utils import print_progress

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Entree-specific constants
# ---------------------------------------------------------------------------
ENTREE_FLASH_MODEL = get_gemini_model("categorize.entree_flash")
ENTREE_PRO_MODEL = get_gemini_model("categorize.entree_pro")
ENTREE_SERVING_SIZE_MAP = {
    ENTREE_LABEL_ENTREE: 1.0,
    ENTREE_LABEL_SIDE_ADDON: 0.5,
}
VALID_ENTREE_CLASSIFICATIONS = {
    ENTREE_LABEL_ENTREE,
    ENTREE_LABEL_SIDE_ADDON,
}
GEMINI_MAX_RETRIES = 3
GEMINI_INITIAL_BACKOFF_SECONDS = 2.0


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------
def _call_gemini_with_retry(prompt: str, gemini_client: Any, model: str) -> str:
    """Call Gemini with exponential backoff on transient errors."""
    last_exception = None
    for attempt in range(GEMINI_MAX_RETRIES):
        try:
            return call_gemini_api(prompt, gemini_client, model=model)
        except Exception as exc:  # pragma: no cover - exercised via tests with monkeypatches
            last_exception = exc
            if attempt < GEMINI_MAX_RETRIES - 1:
                wait = GEMINI_INITIAL_BACKOFF_SECONDS * (2**attempt)
                logger.warning(
                    "Gemini API call failed (attempt %d/%d): %s. Retrying in %.1fs...",
                    attempt + 1,
                    GEMINI_MAX_RETRIES,
                    exc,
                    wait,
                )
                time.sleep(wait)
            else:
                logger.error(
                    "Gemini API call failed after %d attempts: %s",
                    GEMINI_MAX_RETRIES,
                    exc,
                )
    raise last_exception


def _build_unique_entree_products(
    classified_products: pd.DataFrame,
    gbd_categories: set[str],
) -> pd.DataFrame:
    """Build the unique-product review sheet used for entree classification."""
    eligible_products = classified_products.loc[
        classified_products["category"].isin(gbd_categories)
    ].copy()

    review_columns = [
        "product",
        "category",
        "cleaned_item_names",
        "quantity",
    ]
    if eligible_products.empty:
        return pd.DataFrame(columns=review_columns)

    conflicting_categories = eligible_products.groupby("product")["category"].nunique(dropna=True)
    conflicting_products = conflicting_categories[conflicting_categories > 1].index.tolist()
    if conflicting_products:
        raise ValueError(
            "Some products map to multiple categories during entree classification: "
            + ", ".join(sorted(conflicting_products[:10]))
        )

    if "cleaned_item_names" not in eligible_products.columns:
        eligible_products["cleaned_item_names"] = pd.NA

    if "quantity" in eligible_products.columns:
        eligible_products["_entree_quantity"] = pd.to_numeric(
            eligible_products["quantity"],
            errors="coerce",
        )
        aggregated_quantities = (
            eligible_products.groupby("product")["_entree_quantity"].max().fillna(0)
        )
    else:
        aggregated_quantities = eligible_products.groupby("product").size().astype(float)

    grouped_products = (
        eligible_products.groupby("product", as_index=False)
        .agg(
            category=("category", _first_non_empty_value),
            cleaned_item_names=("cleaned_item_names", _first_non_empty_value),
        )
        .copy()
    )
    grouped_products["quantity"] = grouped_products["product"].map(aggregated_quantities)
    grouped_products["cleaned_item_names"] = grouped_products["cleaned_item_names"].fillna(
        grouped_products["product"]
    )
    return grouped_products


def _build_entree_detector_prompt(
    entree_detector_prompt: str,
    product: str,
    cleaned_item_name: Any,
    category: Any,
    allow_unsure: bool,
) -> str:
    """Build the prompt used for first-pass and second-pass entree classification."""
    cleaned_item_name = (
        str(cleaned_item_name).strip()
        if pd.notna(cleaned_item_name) and str(cleaned_item_name).strip()
        else product
    )
    base_prompt = (
        f"{entree_detector_prompt}\n\nProduct: {product}\nCleaned item name: "
        f"{cleaned_item_name}\nGBD protein category: {category}"
    )

    if allow_unsure:
        return (
            f"{base_prompt}\n\nFirst-pass instruction: output exactly one of "
            f"`{ENTREE_LABEL_ENTREE}`, `{ENTREE_LABEL_SIDE_ADDON}`, or `{ENTREE_LABEL_UNSURE}`."
        )

    return (
        f"{base_prompt}\n\nThis item was marked `{ENTREE_LABEL_UNSURE}` on the first pass. "
        f"Resolve it now and output exactly one of `{ENTREE_LABEL_ENTREE}` or "
        f"`{ENTREE_LABEL_SIDE_ADDON}`. Do not output `{ENTREE_LABEL_UNSURE}`."
    )


def _sort_entree_review_sheet(products_to_check: pd.DataFrame) -> pd.DataFrame:
    """Sort the unique-product review sheet for fast manual triage."""
    return products_to_check.sort_values(
        by=[
            "entree_used_pro_model",
            "previously_entree_classified",
            "category",
            "entree_classification",
            "quantity",
            "product",
        ],
        ascending=[False, True, True, True, False, True],
        na_position="last",
    ).reset_index(drop=True)


def _print_entree_summary(products_to_check: pd.DataFrame) -> None:
    """Print per-client entree summary statistics for the review workflow."""
    eligible_unique_products = len(products_to_check)
    cached_products = int(products_to_check["previously_entree_classified"].sum())
    uncached_products = eligible_unique_products - cached_products
    flash_unsure_count = int(
        products_to_check["entree_first_pass_classification"]
        .fillna("")
        .eq(ENTREE_LABEL_UNSURE)
        .sum()
    )
    pro_escalation_count = int(products_to_check["entree_used_pro_model"].sum())
    review_count = int(products_to_check["entree_needs_review"].sum())
    cache_hit_rate = (
        cached_products / eligible_unique_products * 100 if eligible_unique_products > 0 else 0
    )
    flash_unsure_rate = flash_unsure_count / uncached_products * 100 if uncached_products > 0 else 0

    label_counts = products_to_check["entree_classification"].value_counts(dropna=False).to_dict()
    quantity_totals = (
        products_to_check.groupby("entree_classification", dropna=False)["quantity"]
        .sum(min_count=1)
        .to_dict()
    )

    print("\n" + "=" * 60)
    print("ENTREE CLASSIFICATION SUMMARY")
    print("=" * 60)
    print(f"Eligible unique GBD products: {eligible_unique_products}")
    print(f"Historical cache hits: {cached_products} ({cache_hit_rate:.1f}%)")
    print(f"New products sent to Gemini: {uncached_products}")
    print(f"Flash unsure rate: {flash_unsure_count}/{uncached_products} ({flash_unsure_rate:.1f}%)")
    print(f"Gemini Pro escalations: {pro_escalation_count}")
    print(f"Items flagged for review: {review_count}")
    print(
        f"Final {ENTREE_LABEL_ENTREE} count: {label_counts.get(ENTREE_LABEL_ENTREE, 0)} "
        f"(quantity total: {quantity_totals.get(ENTREE_LABEL_ENTREE, 0)})"
    )
    print(
        f"Final {ENTREE_LABEL_SIDE_ADDON} count: {label_counts.get(ENTREE_LABEL_SIDE_ADDON, 0)} "
        f"(quantity total: {quantity_totals.get(ENTREE_LABEL_SIDE_ADDON, 0)})"
    )
    print("=" * 60)


# ---------------------------------------------------------------------------
# Public functions
# ---------------------------------------------------------------------------
def classify_entrees_using_historical_classifications(
    classified_products: pd.DataFrame,
    historical_df: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """
    Match products against historical entree classifications.
    """
    classified_products = classified_products.copy()

    required_cols = {"product", "category"}
    missing_cols = required_cols - set(classified_products.columns)
    if missing_cols:
        raise ValueError(f"classified_products missing required columns: {sorted(missing_cols)}")

    if historical_df is None:
        historical_df = get_previously_classified_entrees()

    historical_subset = historical_df[["product", "entree_classification"]].drop_duplicates(
        subset=["product"],
        keep="last",
    )
    if not historical_subset.empty:
        historical_subset["entree_classification"] = historical_subset[
            "entree_classification"
        ].apply(_normalize_entree_classification)

    classified_products = classified_products.merge(
        historical_subset,
        on="product",
        how="left",
    )

    # Second lookup: reuse labels for recognised cleaned names (mirrors the
    # category pipeline's Step 2.5). Only runs when cleaned names are present
    # both on the rows and in the historical cache; unanimous matches only.
    n_cleaned_matched = 0
    if "cleaned_item_names" in classified_products.columns:
        reuse_index = build_entree_cleaned_name_reuse_index(historical_df)
        mask_unmatched = classified_products["entree_classification"].isna()
        if reuse_index and mask_unmatched.any():
            normalized = classified_products.loc[mask_unmatched, "cleaned_item_names"].map(
                _normalize_product_name
            )
            reused = normalized.map(reuse_index)
            hit_index = reused.dropna().index
            classified_products.loc[hit_index, "entree_classification"] = reused.loc[hit_index]
            n_cleaned_matched = len(hit_index)

    classified_products["previously_entree_classified"] = classified_products[
        "entree_classification"
    ].notna()

    n_matched = int(classified_products["previously_entree_classified"].sum())
    n_total = len(classified_products)
    logger.info(
        "Historical entree classification match: %d/%d products found (%d via cleaned-name reuse).",
        n_matched,
        n_total,
        n_cleaned_matched,
    )

    return classified_products


def assign_serving_sizes_from_entree_classification(
    classified_products: pd.DataFrame,
) -> pd.DataFrame:
    """Assign serving sizes from canonical entree classifications."""
    if "entree_classification" not in classified_products.columns:
        raise ValueError("Input DataFrame must contain an 'entree_classification' column.")

    classified_products = classified_products.copy()
    invalid_labels = classified_products.loc[
        classified_products["entree_classification"].notna()
        & ~classified_products["entree_classification"].isin(ENTREE_SERVING_SIZE_MAP.keys()),
        ["product", "entree_classification"],
    ]
    if not invalid_labels.empty:
        raise ValueError(
            "Cannot assign serving sizes because some entree classifications are invalid: "
            + repr(invalid_labels.to_dict(orient="records"))
        )

    classified_products["serving_size"] = classified_products["entree_classification"].map(
        ENTREE_SERVING_SIZE_MAP
    )
    return classified_products


def run_entree_detector(
    classified_products: pd.DataFrame,
    gemini_client: Any,
    historical_entree_classifications: pd.DataFrame | None = None,
    review_sheet_path: Path = Path("classified_products_with_entree.csv"),
) -> pd.DataFrame:
    """
    Classify GBD-category products as entree or side/add-on.
    """
    if "product" not in classified_products.columns:
        raise ValueError("Input DataFrame 'classified_products' must contain a 'product' column.")
    if "category" not in classified_products.columns:
        raise ValueError("Input DataFrame 'classified_products' must contain a 'category' column.")

    classified_products = classified_products.copy()
    classified_products = classified_products.drop(
        columns=[
            "entree_classification",
            "previously_entree_classified",
            "previously_classified_entree",
            "entree_first_pass_classification",
            "entree_used_pro_model",
            "entree_needs_review",
            "entree_review_reason",
            "serving_size",
        ],
        errors="ignore",
    )

    gbd_categories = set(get_GBD_categories())
    products_to_check = _build_unique_entree_products(classified_products, gbd_categories)

    print(f"Running entree detector, detected {len(products_to_check)} products to check.")
    products_to_check = classify_entrees_using_historical_classifications(
        products_to_check,
        historical_df=historical_entree_classifications,
    )
    products_to_check["entree_first_pass_classification"] = pd.NA
    products_to_check["entree_used_pro_model"] = False
    products_to_check["entree_needs_review"] = False
    products_to_check["entree_review_reason"] = pd.NA

    num_cached = int(products_to_check["previously_entree_classified"].sum())
    cache_hit_rate = num_cached / len(products_to_check) * 100 if len(products_to_check) > 0 else 0
    print(
        f"Found {num_cached} products with historical entree classifications "
        f"({cache_hit_rate:.1f}%)."
    )

    mask_needs_classification = products_to_check["entree_classification"].isna()
    num_to_classify = int(mask_needs_classification.sum())
    print(f"Calling Gemini Flash for {num_to_classify} new entree classifications.")

    if num_to_classify > 0:
        if gemini_client is None:
            raise ValueError(
                "gemini_client must be provided when new entree classifications are needed."
            )

        entree_detector_prompt = load_prompt("entree_detector_prompt.md")
        flash_results = []
        rows_to_classify = products_to_check.loc[
            mask_needs_classification,
            ["product", "cleaned_item_names", "category"],
        ]
        for idx, row in enumerate(rows_to_classify.itertuples(index=False), 1):
            prompt = _build_entree_detector_prompt(
                entree_detector_prompt=entree_detector_prompt,
                product=str(row.product),
                cleaned_item_name=row.cleaned_item_names,
                category=row.category,
                allow_unsure=True,
            )
            result = _call_gemini_with_retry(
                prompt,
                gemini_client,
                model=ENTREE_FLASH_MODEL,
            )
            flash_results.append(_normalize_entree_classification(result, allow_unsure=True))
            print_progress("Entree Flash classification progress", idx, num_to_classify)

        products_to_check.loc[
            mask_needs_classification,
            "entree_first_pass_classification",
        ] = flash_results

        mask_flash_clear = mask_needs_classification & products_to_check[
            "entree_first_pass_classification"
        ].ne(ENTREE_LABEL_UNSURE)
        products_to_check.loc[
            mask_flash_clear,
            "entree_classification",
        ] = products_to_check.loc[
            mask_flash_clear,
            "entree_first_pass_classification",
        ]

        mask_needs_pro = mask_needs_classification & products_to_check[
            "entree_first_pass_classification"
        ].eq(ENTREE_LABEL_UNSURE)
        num_to_escalate = int(mask_needs_pro.sum())
        print(f"Escalating {num_to_escalate} unsure items to Gemini Pro.")

        if num_to_escalate > 0:
            pro_results = []
            rows_for_second_pass = products_to_check.loc[
                mask_needs_pro,
                ["product", "cleaned_item_names", "category"],
            ]
            for idx, row in enumerate(rows_for_second_pass.itertuples(index=False), 1):
                prompt = _build_entree_detector_prompt(
                    entree_detector_prompt=entree_detector_prompt,
                    product=str(row.product),
                    cleaned_item_name=row.cleaned_item_names,
                    category=row.category,
                    allow_unsure=False,
                )
                result = _call_gemini_with_retry(
                    prompt,
                    gemini_client,
                    model=ENTREE_PRO_MODEL,
                )
                pro_results.append(_normalize_entree_classification(result))
                print_progress("Entree Pro classification progress", idx, num_to_escalate)

            products_to_check.loc[mask_needs_pro, "entree_classification"] = pro_results
            products_to_check.loc[mask_needs_pro, "entree_used_pro_model"] = True
            products_to_check.loc[mask_needs_pro, "entree_needs_review"] = True
            products_to_check.loc[mask_needs_pro, "entree_review_reason"] = "flash_unsure"

    invalid_final_labels = products_to_check.loc[
        products_to_check["entree_classification"].notna()
        & ~products_to_check["entree_classification"].isin(
            [ENTREE_LABEL_ENTREE, ENTREE_LABEL_SIDE_ADDON]
        ),
        ["product", "entree_classification"],
    ]
    if not invalid_final_labels.empty:
        raise ValueError(
            "run_entree_detector produced non-canonical final labels: "
            + repr(invalid_final_labels.to_dict(orient="records"))
        )

    missing_final_labels = products_to_check.loc[
        products_to_check["entree_classification"].isna(),
        ["product", "category"],
    ]
    if not missing_final_labels.empty:
        raise ValueError(
            "run_entree_detector failed to assign entree classifications for some eligible "
            "products: " + repr(missing_final_labels.to_dict(orient="records"))
        )

    products_to_check = assign_serving_sizes_from_entree_classification(products_to_check)
    _print_entree_summary(products_to_check)
    review_sheet = _sort_entree_review_sheet(products_to_check)
    review_sheet.to_csv(review_sheet_path, index=False)

    classified_products = classified_products.merge(
        review_sheet[
            [
                "product",
                "entree_classification",
                "previously_entree_classified",
                "entree_first_pass_classification",
                "entree_used_pro_model",
                "entree_needs_review",
                "entree_review_reason",
                "serving_size",
            ]
        ],
        on="product",
        how="left",
    )
    classified_products["previously_entree_classified"] = (
        classified_products["previously_entree_classified"].fillna(False).astype(bool)
    )
    classified_products["previously_classified_entree"] = classified_products[
        "previously_entree_classified"
    ]
    classified_products["entree_used_pro_model"] = (
        classified_products["entree_used_pro_model"].fillna(False).astype(bool)
    )
    classified_products["entree_needs_review"] = (
        classified_products["entree_needs_review"].fillna(False).astype(bool)
    )
    return classified_products
