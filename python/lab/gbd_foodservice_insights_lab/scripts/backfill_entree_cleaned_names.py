#!/usr/bin/env python3
"""Backfill cleaned_item_names in the historical entree cache from the category cache."""

from __future__ import annotations

import argparse
import logging

from gbd_foodservice_insights.categorization.cache import (
    backfill_entree_cleaned_names,
)

logger = logging.getLogger("gbd_foodservice_insights_lab.backfill_entree_cleaned_names")


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments for the backfill script.

    Returns:
        Parsed argument namespace with a ``verbose`` attribute.
    """
    parser = argparse.ArgumentParser(
        description=(
            "Populate the cleaned_item_names column in previously_classified_entrees.csv by "
            "joining to previously_categorized_items.csv on product. Existing cleaned names "
            "are preserved; unmatched products fall back to the raw name."
        )
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Enable debug logging.",
    )
    return parser.parse_args()


def main() -> None:
    """Run the one-shot entree cleaned-name backfill."""
    args = parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s  %(name)s  %(levelname)s  %(message)s",
    )

    summary = backfill_entree_cleaned_names()

    logger.info(
        (
            "Backfill complete: %d rows total — %d already had names, %d borrowed from the "
            "category cache, %d fell back to the raw product name."
        ),
        summary["n_total"],
        summary["n_already"],
        summary["n_borrowed"],
        summary["n_fallback"],
    )


if __name__ == "__main__":
    main()
