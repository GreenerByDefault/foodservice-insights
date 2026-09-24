#!/usr/bin/env python3
"""Promote human-approved web-app categorizations into reviewed historical cache."""

from __future__ import annotations

import argparse
import logging

from gbd_foodservice_insights.categorization.cache import (
    promote_reviewed_web_app_categorizations,
)

logger = logging.getLogger("gbd_foodservice_insights.promote_web_app_categorizations")


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments for the promotion script.

    Returns:
        Parsed argument namespace with ``reviewed_by_default`` and ``verbose`` attributes.
    """
    parser = argparse.ArgumentParser(
        description=(
            "Promote rows from web_app_categorizations_unreviewed.csv where "
            "review_status='approved' into previously_categorized_items.csv."
        )
    )
    parser.add_argument(
        "--reviewed-by-default",
        default=None,
        help=("Fallback reviewer name to use when approved rows are missing reviewed_by."),
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Enable debug logging.",
    )
    return parser.parse_args()


def main() -> None:
    """Run the promotion of approved web-app categorizations to the reviewed cache."""
    args = parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s  %(name)s  %(levelname)s  %(message)s",
    )

    summary = promote_reviewed_web_app_categorizations(
        reviewed_by_default=args.reviewed_by_default,
    )

    logger.info(
        "Promotion complete: %d approved rows processed, %d rows promoted.",
        summary["n_approved"],
        summary["n_promoted"],
    )
    logger.info("Pending rows remaining before this run: %d", summary["n_pending_total"])


if __name__ == "__main__":
    main()
