"""
Food Product Categorization — Orchestrator
============================================

Public entry points for categorization:

    categorize_products()  — main in-memory pipeline
    categorize_file()      — file I/O wrapper around categorize_products()

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
from gbd_foodservice_insights.categorization.entrees import run_entree_detector
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


# ----------------------------------------------------------------------
# Main in-memory pipeline
# ----------------------------------------------------------------------
def categorize_products(
    df: pd.DataFrame,
    openai_client: Any,
    gemini_client: Any | None = None,
    data_type: str = "procurement",
    historical_categorizations: pd.DataFrame | None = None,
    cache_write_mode: Literal["none", "reviewed", "web_app_unreviewed"] = "none",
    historical_entree_classifications: pd.DataFrame | None = None,
    update_historical_entree_classifications: bool = True,
    date_format: str | None = None,
    dayfirst_preference: bool | None = None,
) -> tuple[pd.DataFrame, dict, pd.DataFrame]:
    """
    Categorize food products into GBD emissions categories.

    This is the main entry point for programmatic use (web app, scripts).
    It operates entirely in-memory — no intermediate files are written.

    Parameters
    ----------
    df : DataFrame
        Input data with columns: product, date, weight.
    openai_client : Any
        OpenAI API client for categorization and name cleaning.
    gemini_client : Any, optional
        Gemini API client. Required when data_type="serving".
    data_type : str
        "procurement" or "serving". Serving data also runs entree detection.
    historical_categorizations : DataFrame, optional
        Pre-loaded historical categorizations. If None, loads from default CSV.
    cache_write_mode : Literal["none", "reviewed", "web_app_unreviewed"]
        Controls where new categorizations are persisted:
        - "none": do not persist category cache updates
        - "reviewed": append to reviewed historical cache
        - "web_app_unreviewed": append to unreviewed web-app cache
    historical_entree_classifications : DataFrame, optional
        Pre-loaded historical entree classifications.
        If None, loads from default CSV.
    update_historical_entree_classifications : bool
        Whether to append new entree classifications to the historical file.
    date_format : str, optional
        Date format string. If None, auto-detects.
    dayfirst_preference : bool, optional
        Day/month parsing preference for ambiguous numeric dates.
        - None: fail on ambiguous values (recommended for strict validation)
        - False: interpret as month/day
        - True: interpret as day/month

    Returns
    -------
    tuple[DataFrame, dict, DataFrame]
        - Categorized DataFrame (filtered, cleaned, ready for aggregation)
        - Summary dict with keys: n_products_before, n_products_after,
          pct_remaining, n_rows_before, n_rows_after, row_elimination_details
        - AI-only review table (excludes historically categorized products)
    """
    if openai_client is None:
        raise ValueError("openai_client is required.")

    if data_type == "serving" and gemini_client is None:
        raise ValueError("gemini_client is required for serving data.")

    if data_type not in ("procurement", "serving"):
        raise ValueError(f"Invalid data_type: {data_type!r}. Must be 'procurement' or 'serving'.")

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
        dayfirst_preference=dayfirst_preference,
        allow_missing=False,
    )
    df = clean_weight_column(df, "weight")

    if df["product"].isna().any():
        raise ValueError("Column 'product' contains NaN values after cleaning.")
    if df["weight"].isna().any():
        raise ValueError("Column 'weight' contains NaN values after cleaning.")
    if df["date"].isna().any():
        raise ValueError("Column 'date' contains NaN values after cleaning.")

    n_rows_before = len(df)
    n_products_before = df["product"].nunique()

    # --- Step 1: Match against historical categorizations ---
    unique_products_df = df[["product"]].drop_duplicates().copy()

    if historical_categorizations is None:
        historical_categorizations = get_previously_categorized_items()

    unique_products_df = categorize_using_historical_classifications(
        unique_products_df, historical_categorizations
    )

    # --- Step 2: Clean product names for uncategorized items ---
    unique_products_df = clean_product_names(unique_products_df, openai_client)

    # --- Step 2.5: Reuse categories for recognised cleaned names ---
    cleaned_name_reuse_index = build_cleaned_name_reuse_index(
        reviewed_df=historical_categorizations
    )
    unique_products_df = categorize_using_cleaned_name_history(
        unique_products_df, reuse_index=cleaned_name_reuse_index
    )

    # --- Step 3: LLM categorization for still-uncategorized items ---
    unique_products_df = categorize_with_llm(unique_products_df, openai_client)

    # --- Step 4: Normalize categories (fuzzy match non-standard ones) ---
    unique_products_df = fuzzy_match_GBD_categories(unique_products_df, openai_client)

    check_GBD_categories(unique_products_df)

    # Build human-review table for AI-only categorizations
    ai_review_df = build_ai_review_table(
        original_df=df,
        unique_products_df=unique_products_df,
        include_no_matches=True,
    )

    entree_human_review_df = pd.DataFrame(
        columns=["entree_classification", "product", "category", "occurrence_count"]
    )

    # --- Step 5: Entree detection for serving data ---
    if data_type == "serving":
        if historical_entree_classifications is None:
            historical_entree_classifications = get_previously_classified_entrees()

        unique_products_df = run_entree_detector(
            unique_products_df,
            gemini_client,
            historical_entree_classifications=historical_entree_classifications,
        )
        entree_human_review_df = build_entree_human_review_table(
            original_df=df,
            unique_products_df=unique_products_df,
        )

    # --- Step 6: Update historical cache ---
    cache_write_mode = _validate_cache_write_mode(cache_write_mode)
    if cache_write_mode == "reviewed":
        save_historical_categorizations(unique_products_df)
    elif cache_write_mode == "web_app_unreviewed":
        save_unreviewed_web_app_categorizations(unique_products_df)
    else:
        logger.info("Category cache writes disabled (cache_write_mode='none').")

    if data_type == "serving" and update_historical_entree_classifications:
        save_historical_entree_classifications(unique_products_df)

    # --- Step 7: Merge categorizations back and filter ---
    df_final, summary = merge_categorizations(
        df, unique_products_df, data_type, n_products_before, n_rows_before
    )
    if data_type == "serving":
        summary["_entree_human_review_df"] = entree_human_review_df

    # Provenance breakdown (raw-history / cleaned-name-history / llm) for the
    # cleaned-name reuse hit-rate. Cast to plain str/int so the summary stays
    # JSON-serialisable for the report manifest.
    match_type_counts = {
        str(k): int(v)
        for k, v in unique_products_df["match_type"].fillna("unknown").value_counts().items()
    }
    summary["match_type_counts"] = match_type_counts
    logger.info("Match-type breakdown (unique products): %s", match_type_counts)

    return df_final, summary, ai_review_df


# ----------------------------------------------------------------------
# File I/O wrapper
# ----------------------------------------------------------------------
def categorize_file(
    input_filepath: str | Path,
    output_filepath: str | Path | None = None,
    data_type: str = "procurement",
    openai_client: Any = None,
    gemini_client: Any = None,
    date_format: str | None = None,
    dayfirst_preference: bool | None = None,
    cache_write_mode: Literal["none", "reviewed", "web_app_unreviewed"] = "none",
    update_historical_entree_classifications: bool = True,
) -> tuple[pd.DataFrame, dict]:
    """
    Read a file, categorize products, and write results.

    Thin I/O wrapper around categorize_products().

    Parameters
    ----------
    input_filepath : str or Path
        Path to input file (.csv, .xlsx, .xls, or .xlsm).
    output_filepath : str or Path, optional
        Path for output file. If None, generates name from input file.
    data_type : str
        "procurement" or "serving".
    openai_client : Any
        OpenAI API client.
    gemini_client : Any, optional
        Gemini API client. Required for serving data.
    date_format : str, optional
        Date format string. If None, auto-detects.
    dayfirst_preference : bool, optional
        Day/month parsing preference for ambiguous numeric dates.
        - None: fail on ambiguous values
        - False: interpret as month/day
        - True: interpret as day/month
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
        - Summary dict (same as categorize_products, plus output file keys).
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
    df_result, summary, ai_review_df = categorize_products(
        df=df,
        openai_client=openai_client,
        gemini_client=gemini_client,
        data_type=data_type,
        date_format=date_format,
        dayfirst_preference=dayfirst_preference,
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
