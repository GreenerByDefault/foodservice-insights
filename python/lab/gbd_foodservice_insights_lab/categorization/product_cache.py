"""
Product Cache
=============

The lab's copy of the product-categorization cache, a CSV on disk. The product reads the
verified rows from the database, never this file.
"""

import logging
from pathlib import Path

import pandas as pd
from gbd_foodservice_insights.categorization.cache import CACHE_COLUMNS, CategorizationCache

from gbd_foodservice_insights_lab import PACKAGE_DIR

logger = logging.getLogger(__name__)


def categorization_cache_path() -> Path:
    return PACKAGE_DIR / "data_files" / "previously_categorized_items.csv"


def read_categorization_cache_csv() -> pd.DataFrame:
    """The cache file exactly as written, every cell a `str` (so a product named `NA` stays
    one); empty, with `CACHE_COLUMNS`, when the file is missing.

    The pipeline wants `load_categorization_cache`. This is for the lab's writers, which must
    append to the file without discarding the rows `from_frame` drops.
    """
    path = categorization_cache_path()
    if not path.exists():
        logger.warning(
            "Historical cache not found at %s (see data_files/README.md); every product will go "
            "to the LLM.",
            path,
        )
        return pd.DataFrame(columns=list(CACHE_COLUMNS), dtype=str)

    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    logger.info("Read %d rows from historical cache.", len(df))
    return df


def load_categorization_cache() -> CategorizationCache:
    return CategorizationCache.from_frame(read_categorization_cache_csv())
