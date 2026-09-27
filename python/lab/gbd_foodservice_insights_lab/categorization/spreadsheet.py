"""
Categorize a spreadsheet to CSVs, including serving data's entree detection.

Composes the product's `categorize_unique_products` and `merge_categorizations` the way
`gbd_foodservice_insights.analysis` does, then, for serving data, keeps only the entree rows.
"""

import logging
from pathlib import Path
from typing import Any, Literal

import pandas as pd
from gbd_foodservice_insights.categorization.llm import LlmClient
from gbd_foodservice_insights.categorization.pipeline import categorize_unique_products
from gbd_foodservice_insights.categorization.steps import merge_categorizations

from gbd_foodservice_insights_lab.categorization.entree_cache import (
    get_previously_classified_entrees,
    save_historical_entree_classifications,
)
from gbd_foodservice_insights_lab.categorization.entrees import (
    build_entree_human_review_table,
    filter_to_entrees,
    run_entree_detector,
)

logger = logging.getLogger(__name__)


def categorize_spreadsheet_to_csvs(
    input_filepath: str | Path,
    llm: LlmClient,
    output_filepath: str | Path | None = None,
    data_type: Literal["procurement", "serving"] = "procurement",
    gemini_client: Any = None,
    date_format: str | None = None,
    cache_write_mode: Literal["none", "reviewed", "web_app_unreviewed"] = "none",
    update_historical_entree_classifications: bool = True,
) -> tuple[pd.DataFrame, dict]:
    """Read a file, categorize products, and write results.

    The input may be .csv, .xlsx, .xls, or .xlsm; ``output_filepath`` defaults to the input name
    with a ``_categorized`` suffix, and ``date_format`` is auto-detected when ``None``. Serving
    data also runs entree detection, keeps only the entree rows, and requires ``gemini_client``.

    ``cache_write_mode`` controls where new categorizations are persisted: ``"none"`` skips it,
    ``"reviewed"`` appends to the reviewed historical cache, and ``"web_app_unreviewed"`` appends
    to the unreviewed web-app cache. ``update_historical_entree_classifications`` appends new
    entree classifications to the historical file.

    Returns the categorized frame and a summary dict: ``MergeCounts.to_summary()``, plus
    ``match_type_counts`` and the output file keys.
    """
    if data_type not in ("procurement", "serving"):
        raise ValueError(f"Invalid data_type: {data_type!r}. Must be 'procurement' or 'serving'.")
    if data_type == "serving" and gemini_client is None:
        raise ValueError("gemini_client is required for serving data.")

    input_filepath = Path(input_filepath)

    output_filepath = (
        Path(output_filepath)
        if output_filepath is not None
        else input_filepath.with_stem(input_filepath.stem + "_categorized")
    )

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

    categorized = categorize_unique_products(
        df=df,
        llm=llm,
        date_format=date_format,
        cache_write_mode=cache_write_mode,
    )
    df_result, counts = merge_categorizations(
        categorized.cleaned_df, categorized.unique_products_df
    )

    entree_review_df = None
    if data_type == "serving":
        classified_products = run_entree_detector(
            categorized.unique_products_df,
            gemini_client,
            historical_entree_classifications=get_previously_classified_entrees(),
            review_sheet_path=output_filepath.with_stem(
                output_filepath.stem + "_classified_with_entree"
            ),
        )
        entree_review_df = build_entree_human_review_table(
            original_df=categorized.cleaned_df,
            unique_products_df=classified_products,
        )
        if update_historical_entree_classifications:
            save_historical_entree_classifications(classified_products)
        df_result, counts = filter_to_entrees(df_result, counts, classified_products)

    summary = counts.to_summary()
    summary["match_type_counts"] = categorized.match_type_counts

    # Write output
    df_result.to_csv(output_filepath, index=False)
    summary["output_file"] = str(output_filepath)
    logger.info("Wrote categorized output to %s", output_filepath)

    human_review_filepath = output_filepath.with_stem(output_filepath.stem + "_for_human_review")
    categorized.ai_review_df.to_csv(human_review_filepath, index=False)
    summary["human_review_file"] = str(human_review_filepath)
    summary["human_review_n_unique_products"] = len(categorized.ai_review_df)
    logger.info("Wrote human review output to %s", human_review_filepath)

    if entree_review_df is not None:
        entree_human_review_filepath = output_filepath.with_stem(
            output_filepath.stem + "_entree_for_human_review"
        )
        entree_review_df.to_csv(entree_human_review_filepath, index=False)
        summary["entree_human_review_file"] = str(entree_human_review_filepath)
        summary["entree_human_review_n_unique_products"] = len(entree_review_df)
        logger.info("Wrote entree human review output to %s", entree_human_review_filepath)

    return df_result, summary
