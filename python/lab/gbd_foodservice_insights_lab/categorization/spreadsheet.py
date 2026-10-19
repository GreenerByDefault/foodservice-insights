"""
Categorize a spreadsheet to CSVs, including serving data's entree detection.

Composes the product's `categorize_unique_products` and `merge_categorizations` the way
`gbd_foodservice_insights.analysis` does, then, for serving data, keeps only the entree rows.
"""

import dataclasses
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import pandas as pd
from gbd_foodservice_insights.categorization.llm import LlmClient
from gbd_foodservice_insights.categorization.pipeline import (
    NewCategorization,
    categorize_unique_products,
)
from gbd_foodservice_insights.categorization.steps import merge_categorizations

from gbd_foodservice_insights_lab import cache_sync
from gbd_foodservice_insights_lab.categorization.entree_cache import (
    get_previously_classified_entrees,
)
from gbd_foodservice_insights_lab.categorization.entrees import (
    filter_to_entrees,
    new_entree_classifications,
    run_entree_detector,
)
from gbd_foodservice_insights_lab.categorization.product_cache import load_categorization_cache
from gbd_foodservice_insights_lab.parsing import (
    clean_weight_column,
    parse_and_validate_date_column,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MergeCounts:
    """How many rows and products survived the merge, and why the rest did not."""

    n_rows_before: int
    n_rows_after: int
    n_products_before: int
    n_products_after: int
    n_rows_uncategorized: int

    @classmethod
    def between(cls, before: pd.DataFrame, after: pd.DataFrame) -> MergeCounts:
        """The counts across `merge_categorizations`, which drops only uncategorized rows."""
        return cls(
            n_rows_before=len(before),
            n_rows_after=len(after),
            n_products_before=before["product"].nunique(),
            n_products_after=after["product"].nunique(),
            n_rows_uncategorized=len(before) - len(after),
        )


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
    push_suggestions: bool = True,
) -> tuple[pd.DataFrame, dict]:
    """Read a file, categorize products, and write results.

    The input may be .csv, .xlsx, .xls, or .xlsm; ``output_filepath`` defaults to the input name
    with a ``_categorized`` suffix, and ``date_format`` is auto-detected when ``None``. Serving
    data also runs entree detection, keeps only the entree rows, and requires ``gemini_client``.

    ``push_suggestions`` suggests the run's new categorizations and entree classifications to
    the database's caches, where a human verifies them before any run uses them. Turn it off for a
    prompt experiment: the first suggestion of a product wins, so an experiment's answer would
    block the real one.

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
    df_result = merge_categorizations(categorized.cleaned_df, categorized.unique_products_df)
    counts = MergeCounts.between(categorized.cleaned_df, df_result)

    new_entrees = None
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
        new_entrees = new_entree_classifications(classified_products)
        # After the merge, not before, so that side/add-ons do not count toward the merge's "over
        # 80% of products eliminated" check: a file that is mostly sides is still usable serving
        # data. `n_products_after` keeps its pre-filter value for the same reason.
        df_result, n_rows_non_entree = filter_to_entrees(df_result, classified_products)
        counts = dataclasses.replace(counts, n_rows_after=len(df_result))

    summary = merge_summary(counts, n_rows_non_entree=n_rows_non_entree)
    summary["match_type_counts"] = (
        categorized.unique_products_df["match_type"].value_counts().to_dict()
    )

    # Write output
    df_result.to_csv(output_filepath, index=False)
    summary["output_file"] = str(output_filepath)
    logger.info("Wrote categorized output to %s", output_filepath)

    if push_suggestions:
        cache_sync.push_suggestions_if_configured(
            _categorizations_frame(categorized.new_categorizations), new_entrees
        )
    else:
        logger.info("push_suggestions is off, so this run's new answers are not suggested.")

    return df_result, summary


def _categorizations_frame(rows: Sequence[NewCategorization]) -> pd.DataFrame:
    """`rows` in the categorization cache file's columns."""
    return pd.DataFrame(
        {
            "product": [row.product for row in rows],
            "category": [row.category for row in rows],
            "cleaned_item_names": [row.cleaned_name for row in rows],
        }
    )
