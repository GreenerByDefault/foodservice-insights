#!/usr/bin/env python3
"""
Categorization CLI Script
=========================

Thin CLI entrypoint around
gbd_foodservice_insights_lab.categorization.spreadsheet.categorize_spreadsheet_to_csvs().

Usage:
    python "1. Categorize Runscript.py" --input data.csv
    python "1. Categorize Runscript.py" --input data.csv --data-type serving
    python "1. Categorize Runscript.py" --input data.csv --output results.csv --date-format "%b-%y"
"""

import argparse
import logging

from dotenv import find_dotenv, load_dotenv
from gbd_foodservice_insights.categorization.llm import OpenAiLlmClient
from gbd_foodservice_insights_lab.categorization.spreadsheet import categorize_spreadsheet_to_csvs
from gbd_foodservice_insights_lab.notebook_runscript_setup import (
    setup_api_clients,
    update_metadata_with_categorization_stats,
)

logger = logging.getLogger("gbd_foodservice_insights.runscript")


def main() -> None:
    """Run the categorization CLI for procurement or serving data.

    Parses command-line arguments, sets up logging and API clients, calls
    ``categorize_spreadsheet_to_csvs`` to assign GBD categories to every line item, and
    persists categorization statistics back into ``client_metadata.json``.
    """
    parser = argparse.ArgumentParser(
        description="Categorize food products from procurement or serving data."
    )
    parser.add_argument("--input", "-i", required=True, help="Input file (CSV/Excel)")
    parser.add_argument("--output", "-o", default=None, help="Output CSV path")
    parser.add_argument(
        "--data-type",
        "-d",
        default="procurement",
        choices=["procurement", "serving"],
        help="Type of data (default: procurement)",
    )
    parser.add_argument(
        "--date-format", default=None, help="Date format string (default: auto-detect)"
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="Enable debug logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s  %(name)s  %(levelname)s  %(message)s",
    )

    # Load .env and set up API clients
    env_path = find_dotenv(usecwd=True)
    load_dotenv(dotenv_path=env_path)
    clients = setup_api_clients(gemini=(args.data_type == "serving"))

    logger.info("Input:  %s", args.input)
    logger.info("Output: %s", args.output or "(auto)")
    logger.info("Type:   %s", args.data_type)

    # Basically, all the functionality in this script is nested inside the
    # `categorize_spreadsheet_to_csvs` function because it separates "CLI stuff"
    # e.g. this allows for unit testing without having to fake CLI arguments.
    _df, summary = categorize_spreadsheet_to_csvs(
        input_filepath=args.input,
        output_filepath=args.output,
        data_type=args.data_type,
        llm=OpenAiLlmClient.from_env(),
        gemini_client=clients.get("gemini_client"),
        date_format=args.date_format,
    )

    # Save categorization statistics to client_metadata.json
    update_metadata_with_categorization_stats(summary)

    logger.info(
        "Done — %d/%d products retained (%.1f%%)",
        summary["n_products_after"],
        summary["n_products_before"],
        summary["pct_remaining"] * 100,
    )
    logger.info("Output written to %s", summary.get("output_file", args.output))
    logger.info("Human review output written to %s", summary.get("human_review_file", "(not set)"))


if __name__ == "__main__":
    main()
