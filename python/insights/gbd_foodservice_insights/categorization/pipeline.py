"""
Food Product Categorization — Orchestrator
============================================

Public entry points for categorization:

    categorize_unique_products() — clean the input and categorize each unique product
    categorize_rows()            — the above, merged back onto the input rows, plus
                                   entree detection for serving data
    categorize_file()            — file I/O wrapper around categorize_rows()

All helper logic lives in sibling modules:

    steps.py    — historical reuse, name cleaning, LLM categorization,
                 fuzzy matching, merge-back
    entrees.py  — entree detection for serving data
    reviews.py  — human-review table construction
    cache.py    — reviewed/unreviewed cache persistence, promotion,
                 entree history
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import pandas as pd

from gbd_foodservice_insights.categories import check_GBD_categories
from gbd_foodservice_insights.categorization.cache import (
    _validate_cache_write_mode,
    build_cleaned_name_reuse_index,
    get_previously_categorized_items,
    get_previously_classified_entrees,
    save_historical_categorizations,
    save_historical_entree_classifications,
    save_unreviewed_web_app_categorizations,
)
from gbd_foodservice_insights.categorization.entrees import filter_to_entrees, run_entree_detector
from gbd_foodservice_insights.categorization.llm import LlmClient
from gbd_foodservice_insights.categorization.reviews import (
    build_ai_review_table,
    build_entree_human_review_table,
)
from gbd_foodservice_insights.categorization.steps import (
    categorize_using_cleaned_name_history,
    categorize_using_historical_classifications,
    categorize_with_llm,
    clean_product_names,
    fuzzy_match_GBD_categories,
    merge_categorizations,
)
from gbd_foodservice_insights.report.diagnostics import (
    clean_weight_column,
    parse_and_validate_date_column,
)
from gbd_foodservice_insights.utils import get_default_output_file

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CategorizedProducts:
    cleaned_df: pd.DataFrame  # the input rows, with product, date and weight cleaned
    unique_products_df: pd.DataFrame  # one row per product, with its category
    ai_review_df: pd.DataFrame  # the products an LLM categorized, for human review
    match_type_counts: dict[str, int]


# ----------------------------------------------------------------------
# Main pipeline
# ----------------------------------------------------------------------
def categorize_unique_products(
    df: pd.DataFrame,
    llm: LlmClient,
    historical_categorizations: pd.DataFrame | None = None,
    cache_write_mode: Literal["none", "reviewed", "web_app_unreviewed"] = "none",
    date_format: str | None = None,
) -> CategorizedProducts:
    """
    Clean the input and assign a GBD emissions category to each unique product.

    Reads the packaged category cache when `historical_categorizations` is None, and writes
    new categorizations to a cache according to `cache_write_mode`.

    Parameters
    ----------
    df : DataFrame
        Input data with columns: product, date, weight.
    llm : LlmClient
        Categorization and name cleaning.
    historical_categorizations : DataFrame, optional
        Pre-loaded historical categorizations. If None, loads from default CSV.
    cache_write_mode : Literal["none", "reviewed", "web_app_unreviewed"]
        Controls where new categorizations are persisted:
        - "none": do not persist category cache updates
        - "reviewed": append to reviewed historical cache
        - "web_app_unreviewed": append to unreviewed web-app cache
    date_format : str, optional
        Date format string. If None, auto-detects.
    """
    cache_write_mode = _validate_cache_write_mode(cache_write_mode)

    # --- Validate required columns ---
    for col in ("product", "date", "weight"):
        if col not in df.columns:
            raise ValueError(f"Column '{col}' not found in DataFrame.")

    df = df.copy()

    # --- Clean input data ---
    df["product"] = df["product"].astype(str).str.strip()

    df = parse_and_validate_date_column(
        df=df,
        date_col="date",
        date_format=date_format,
        allow_missing=False,
    )
    df = clean_weight_column(df, "weight")

    if df["product"].isna().any():
        raise ValueError("Column 'product' contains NaN values after cleaning.")
    if df["weight"].isna().any():
        raise ValueError("Column 'weight' contains NaN values after cleaning.")
    if df["date"].isna().any():
        raise ValueError("Column 'date' contains NaN values after cleaning.")

    # --- Step 1: Match against historical categorizations ---
    unique_products_df = df[["product"]].drop_duplicates().copy()

    if historical_categorizations is None:
        historical_categorizations = get_previously_categorized_items()

    unique_products_df = categorize_using_historical_classifications(
        unique_products_df, historical_categorizations
    )

    # --- Step 2: Clean product names for uncategorized items ---
    unique_products_df = clean_product_names(unique_products_df, llm)

    # --- Step 2.5: Reuse categories for recognised cleaned names ---
    cleaned_name_reuse_index = build_cleaned_name_reuse_index(
        reviewed_df=historical_categorizations
    )
    unique_products_df = categorize_using_cleaned_name_history(
        unique_products_df, reuse_index=cleaned_name_reuse_index
    )

    # --- Step 3: LLM categorization for still-uncategorized items ---
    unique_products_df = categorize_with_llm(unique_products_df, llm)

    # --- Step 4: Normalize categories (fuzzy match non-standard ones) ---
    unique_products_df = fuzzy_match_GBD_categories(unique_products_df, llm)

    check_GBD_categories(unique_products_df)

    # Build human-review table for AI-only categorizations
    ai_review_df = build_ai_review_table(
        original_df=df,
        unique_products_df=unique_products_df,
        include_no_matches=True,
    )

    # --- Update historical cache ---
    if cache_write_mode == "reviewed":
        save_historical_categorizations(unique_products_df)
    elif cache_write_mode == "web_app_unreviewed":
        save_unreviewed_web_app_categorizations(unique_products_df)
    else:
        logger.info("Category cache writes disabled (cache_write_mode='none').")

    # Provenance breakdown (raw-history / cleaned-name-history / llm) for the
    # cleaned-name reuse hit-rate. Cast to plain str/int so the summary stays
    # JSON-serialisable for the report manifest.
    match_type_counts = {
        str(k): int(v)
        for k, v in unique_products_df["match_type"].fillna("unknown").value_counts().items()
    }
    logger.info("Match-type breakdown (unique products): %s", match_type_counts)

    return CategorizedProducts(
        cleaned_df=df,
        unique_products_df=unique_products_df,
        ai_review_df=ai_review_df,
        match_type_counts=match_type_counts,
    )


def categorize_rows(
    df: pd.DataFrame,
    llm: LlmClient,
    gemini_client: Any | None = None,
    data_type: str = "procurement",
    historical_categorizations: pd.DataFrame | None = None,
    cache_write_mode: Literal["none", "reviewed", "web_app_unreviewed"] = "none",
    historical_entree_classifications: pd.DataFrame | None = None,
    update_historical_entree_classifications: bool = True,
    date_format: str | None = None,
) -> tuple[pd.DataFrame, dict, pd.DataFrame]:
    """
    Give each input row its product's GBD emissions category, dropping uncategorized rows.

    This is the main entry point for programmatic use (web app, scripts).

    Parameters
    ----------
    df, llm, historical_categorizations, cache_write_mode, date_format
        As for `categorize_unique_products`.
    gemini_client : Any, optional
        Gemini API client. Required when data_type="serving".
    data_type : str
        "procurement" or "serving". Serving data also runs entree detection.
    historical_entree_classifications : DataFrame, optional
        Pre-loaded historical entree classifications.
        If None, loads from default CSV.
    update_historical_entree_classifications : bool
        Whether to append new entree classifications to the historical file.

    Returns
    -------
    tuple[DataFrame, dict, DataFrame]
        - Categorized DataFrame (filtered, cleaned, ready for aggregation)
        - Summary dict with keys: n_products_before, n_products_after,
          pct_remaining, n_rows_before, n_rows_after, row_elimination_details,
          match_type_counts
        - AI-only review table (excludes historically categorized products)
    """
    if data_type == "serving" and gemini_client is None:
        raise ValueError("gemini_client is required for serving data.")

    if data_type not in ("procurement", "serving"):
        raise ValueError(f"Invalid data_type: {data_type!r}. Must be 'procurement' or 'serving'.")

    categorized = categorize_unique_products(
        df,
        llm,
        historical_categorizations=historical_categorizations,
        cache_write_mode=cache_write_mode,
        date_format=date_format,
    )
    df_final, counts = merge_categorizations(categorized.cleaned_df, categorized.unique_products_df)

    # --- Entree detection for serving data ---
    entree_human_review_df = None
    if data_type == "serving":
        if historical_entree_classifications is None:
            historical_entree_classifications = get_previously_classified_entrees()

        classified_products = run_entree_detector(
            categorized.unique_products_df,
            gemini_client,
            historical_entree_classifications=historical_entree_classifications,
        )
        entree_human_review_df = build_entree_human_review_table(
            original_df=categorized.cleaned_df,
            unique_products_df=classified_products,
        )
        if update_historical_entree_classifications:
            save_historical_entree_classifications(classified_products)
        df_final, counts = filter_to_entrees(df_final, counts, classified_products)

    summary = counts.to_summary()
    if entree_human_review_df is not None:
        summary["_entree_human_review_df"] = entree_human_review_df
    summary["match_type_counts"] = categorized.match_type_counts
    return df_final, summary, categorized.ai_review_df


# ----------------------------------------------------------------------
# File I/O wrapper
# ----------------------------------------------------------------------
def categorize_file(
    input_filepath: str | Path,
    llm: LlmClient,
    output_filepath: str | Path | None = None,
    data_type: str = "procurement",
    gemini_client: Any = None,
    date_format: str | None = None,
    cache_write_mode: Literal["none", "reviewed", "web_app_unreviewed"] = "none",
    update_historical_entree_classifications: bool = True,
) -> tuple[pd.DataFrame, dict]:
    """
    Read a file, categorize products, and write results.

    Thin I/O wrapper around categorize_rows().

    Parameters
    ----------
    input_filepath : str or Path
        Path to input file (.csv, .xlsx, .xls, or .xlsm).
    llm : LlmClient
        Categorization and name cleaning.
    output_filepath : str or Path, optional
        Path for output file. If None, generates name from input file.
    data_type : str
        "procurement" or "serving".
    gemini_client : Any, optional
        Gemini API client. Required for serving data.
    date_format : str, optional
        Date format string. If None, auto-detects.
    cache_write_mode : Literal["none", "reviewed", "web_app_unreviewed"]
        Controls where new categorizations are persisted:
        - "none": do not persist category cache updates
        - "reviewed": append to reviewed historical cache
        - "web_app_unreviewed": append to unreviewed web-app cache
    update_historical_entree_classifications : bool
        Whether to append new entree classifications to the historical file.

    Returns
    -------
    tuple[DataFrame, dict]
        - The categorized DataFrame.
        - Summary dict (same as categorize_rows, plus output file keys).
    """
    input_filepath = Path(input_filepath)

    if output_filepath is None:
        output_filepath = get_default_output_file(str(input_filepath), "_categorized")
    output_filepath = Path(output_filepath)

    # Read input file
    suffix = input_filepath.suffix.lower()
    if suffix == ".csv":
        df = pd.read_csv(input_filepath)
    elif suffix in (".xlsx", ".xls", ".xlsm"):
        df = pd.read_excel(input_filepath, sheet_name=0)
    else:
        raise ValueError(
            f"Unsupported file type: {suffix}. Supported formats: .csv, .xlsx, .xls, .xlsm"
        )

    logger.info("Read %d rows from %s", len(df), input_filepath.name)

    # Run core pipeline
    df_result, summary, ai_review_df = categorize_rows(
        df=df,
        llm=llm,
        gemini_client=gemini_client,
        data_type=data_type,
        date_format=date_format,
        cache_write_mode=cache_write_mode,
        update_historical_entree_classifications=update_historical_entree_classifications,
    )

    # Write output
    df_result.to_csv(output_filepath, index=False)
    summary["output_file"] = str(output_filepath)

    human_review_filepath = output_filepath.with_stem(output_filepath.stem + "_for_human_review")
    ai_review_df.to_csv(human_review_filepath, index=False)
    summary["human_review_file"] = str(human_review_filepath)
    summary["human_review_n_unique_products"] = len(ai_review_df)

    if data_type == "serving":
        entree_review_df = summary.pop(
            "_entree_human_review_df",
            pd.DataFrame(
                columns=[
                    "entree_classification",
                    "product",
                    "category",
                    "occurrence_count",
                ]
            ),
        )
        entree_human_review_filepath = output_filepath.with_stem(
            output_filepath.stem + "_entree_for_human_review"
        )
        entree_review_df.to_csv(entree_human_review_filepath, index=False)
        summary["entree_human_review_file"] = str(entree_human_review_filepath)
        summary["entree_human_review_n_unique_products"] = len(entree_review_df)

    logger.info("Wrote categorized output to %s", output_filepath)
    logger.info("Wrote human review output to %s", human_review_filepath)
    if data_type == "serving":
        logger.info("Wrote entree human review output to %s", summary["entree_human_review_file"])

    return df_result, summary
