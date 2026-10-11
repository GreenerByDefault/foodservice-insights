"""
Categorize a spreadsheet to CSVs, including serving data's entree detection.

Composes the product's `categorize_unique_products` and `merge_categorizations` the way
`gbd_foodservice_insights.analysis` does, then, for serving data, keeps only the entree rows.
"""

import logging
from pathlib import Path
from typing import Any, Literal

import pandas as pd
from gbd_foodservice_insights.categorization.cache import load_categorization_cache
from gbd_foodservice_insights.categorization.llm import LlmClient
from gbd_foodservice_insights.categorization.pipeline import categorize_unique_products
from gbd_foodservice_insights.categorization.steps import MergeCounts, merge_categorizations

from gbd_foodservice_insights_lab.categorization.entree_cache import (
    get_previously_classified_entrees,
    save_historical_entree_classifications,
)
from gbd_foodservice_insights_lab.categorization.entrees import (
    build_entree_human_review_table,
    filter_to_entrees,
    run_entree_detector,
)
from gbd_foodservice_insights_lab.parsing import (
    clean_weight_column,
    parse_and_validate_date_column,
)

logger = logging.getLogger(__name__)


def merge_summary(counts: MergeCounts, *, n_rows_non_entree: int | None = None) -> dict[str, Any]:
    """The runscripts' categorization stats; the non-entree keys appear only for serving data."""

    def pct_of_rows(n_rows: int) -> float:
        return n_rows / counts.n_rows_before if counts.n_rows_before > 0 else 0

    n_rows_eliminated = counts.n_rows_before - counts.n_rows_after
    row_elimination_details: dict[str, Any] = {
        "total_rows_initial": counts.n_rows_before,
        "total_rows_final": counts.n_rows_after,
        "total_rows_eliminated": n_rows_eliminated,
        "total_eliminated_pct": pct_of_rows(n_rows_eliminated),
        "rows_eliminated_uncategorized": counts.n_rows_uncategorized,
        "rows_eliminated_uncategorized_pct": pct_of_rows(counts.n_rows_uncategorized),
    }
    if n_rows_non_entree is not None:
        row_elimination_details |= {
            "rows_eliminated_non_entree": n_rows_non_entree,
            "rows_eliminated_non_entree_pct": pct_of_rows(n_rows_non_entree),
        }
    return {
        "n_products_before": counts.n_products_before,
        "n_products_after": counts.n_products_after,
        "pct_remaining": counts.n_products_after / counts.n_products_before,
        "n_rows_before": counts.n_rows_before,
        "n_rows_after": counts.n_rows_after,
        "row_elimination_details": row_elimination_details,
    }


def categorize_spreadsheet_to_csvs(
    input_filepath: str | Path,
    llm: LlmClient,
    output_filepath: str | Path | None = None,
    data_type: Literal["procurement", "serving"] = "procurement",
    gemini_client: Any = None,
    date_format: str | None = None,
    update_historical_entree_classifications: bool = True,
) -> tuple[pd.DataFrame, dict]:
    """Read a file, categorize products, and write results.

    The input may be .csv, .xlsx, .xls, or .xlsm; ``output_filepath`` defaults to the input name
    with a ``_categorized`` suffix, and ``date_format`` is auto-detected when ``None``. Serving
    data also runs entree detection, keeps only the entree rows, and requires ``gemini_client``.

    ``update_historical_entree_classifications`` appends new entree classifications to the
    historical file. New product categorizations are never cached here.

    Returns the categorized frame and a summary dict: `merge_summary`, plus
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

    for col in ("product", "date", "weight"):
        if col not in df.columns:
            raise ValueError(f"Column '{col}' not found in {input_filepath.name}.")
    df = df.assign(product=df["product"].astype(str))
    df = clean_weight_column(parse_and_validate_date_column(df, date_format=date_format), "weight")

    categorized = categorize_unique_products(
        df=df,
        llm=llm,
        cache=load_categorization_cache(),
    )
    df_result, counts = merge_categorizations(
        categorized.cleaned_df, categorized.unique_products_df
    )

    entree_review_df = None
    n_rows_non_entree = None
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
        df_result, counts, n_rows_non_entree = filter_to_entrees(
            df_result, counts, classified_products
        )

    summary = merge_summary(counts, n_rows_non_entree=n_rows_non_entree)
    summary["match_type_counts"] = categorized.match_type_counts

    # Write output
    df_result.to_csv(output_filepath, index=False)
    summary["output_file"] = str(output_filepath)
    logger.info("Wrote categorized output to %s", output_filepath)

    if entree_review_df is not None:
        entree_human_review_filepath = output_filepath.with_stem(
            output_filepath.stem + "_entree_for_human_review"
        )
        entree_review_df.to_csv(entree_human_review_filepath, index=False)
        summary["entree_human_review_file"] = str(entree_human_review_filepath)
        summary["entree_human_review_n_unique_products"] = len(entree_review_df)
        logger.info("Wrote entree human review output to %s", entree_human_review_filepath)

    return df_result, summary
