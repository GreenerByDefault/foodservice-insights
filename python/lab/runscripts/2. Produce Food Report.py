#!/usr/bin/env python3
"""
Food Report CLI Script
======================

Thin CLI wrapper around gbd_foodservice_insights.report.pipeline.run_food_report().

Reads a categorized CSV and a diner-meals JSON file, calculates carbon
emissions, runs diagnostics and aggregation, and produces a client-facing
PDF report, a client workbook, an internal QA workbook, a run manifest, and
an internal log file.

Usage (from a client data directory):
    python "2. Produce Food Report.py" \\
        --input categorized_data.csv \\
        --diner-meals diner_meals.json

    python "2. Produce Food Report.py" \\
        --input categorized_data.csv \\
        --diner-meals diner_meals.json \\
        --region europe \\
        --top-n 10

Programmatic usage:
    from gbd_foodservice_insights.report.pipeline import run_food_report

    results = run_food_report(
        input_file="categorized_data.csv",
        diner_meal_file="diner_meals.json",
        region="us",
    )
    print(results["pdf_path"])
"""

import argparse
import logging
from pathlib import Path

from gbd_foodservice_insights.report.pipeline import run_food_report
from gbd_foodservice_insights.utils import rel_path

logger = logging.getLogger("gbd_foodservice_insights.food_report_cli")


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments for the food report CLI.

    Returns:
        The parsed ``argparse.Namespace`` containing the input file, diner-meals
        file, output directory, region, top-N driver count, and other report
        configuration flags.
    """
    parser = argparse.ArgumentParser(
        description=(
            "Generate a food report bundle from categorized data. Requires a categorized "
            "CSV and a diner-meals JSON file."
        ),
    )
    parser.add_argument(
        "--input",
        "-i",
        default=None,
        help=(
            "Path to the categorized CSV file. If omitted, auto-detected from "
            "'report_input_file' in client_metadata.json."
        ),
    )
    parser.add_argument(
        "--diner-meals",
        "-d",
        required=True,
        help=(
            "Path to a JSON file mapping month strings to diner/meal counts, e.g. "
            '{"2024-01": 5000, "2024-02": 4800}.'
        ),
    )
    parser.add_argument(
        "--output-dir",
        "-o",
        default=None,
        help="Output directory (defaults to outputs/<input-name>/ beside the input file).",
    )
    parser.add_argument(
        "--procurement-serving",
        "-p",
        default=None,
        choices=["procurement", "serving"],
        help="Override auto-detection from client_metadata.json.",
    )
    parser.add_argument(
        "--diner-or-meal",
        default="diner",
        choices=["diner", "meal"],
        help='Label: "diner" or "meal" (default: diner).',
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=5,
        help="Number of top driver products to show (default: 5).",
    )
    parser.add_argument(
        "--region",
        "-r",
        default="us",
        choices=["us", "europe"],
        help="Emission-factor region (default: us).",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Enable debug logging.",
    )
    parser.add_argument(
        "--missing-data-policy",
        default="hard_fail",
        choices=["warn_continue", "hard_fail"],
        help=(
            "How to handle missing/invalid required data: 'hard_fail' (default, raises on "
            "errors) or 'warn_continue' (produce a diagnostic report even with errors)."
        ),
    )
    return parser.parse_args()


def main() -> None:
    """Run the food report CLI end-to-end.

    Parses CLI arguments, configures logging, resolves the input CSV (either
    from the explicit ``--input`` argument or from ``client_metadata.json``),
    invokes ``run_food_report`` to produce the full artifact bundle, and prints
    a summary of the output paths and quality status to the console.
    """
    args = parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s  %(name)s  %(levelname)s  %(message)s",
    )

    logger.info("Input:       %s", rel_path(args.input) or "(auto-detect from metadata)")
    logger.info("Diner-meals: %s", rel_path(args.diner_meals))
    logger.info(
        "Output dir:  %s",
        rel_path(args.output_dir) or "(auto: outputs/<input-name>/ beside input)",
    )
    logger.info("Region:      %s", args.region)

    # Resolve input path: use explicit arg or auto-detect from metadata
    input_file = args.input
    if input_file is None:
        import json

        meta_path = Path.cwd() / "client_metadata.json"
        if not meta_path.exists():
            raise FileNotFoundError("No --input provided and no client_metadata.json in cwd")
        with open(meta_path) as f:
            input_file = json.load(f).get("report_input_file")
        if not input_file:
            raise ValueError("No --input provided and 'report_input_file' not in metadata")
        logger.info("Auto-detected input: %s", input_file)

    results = run_food_report(
        input_file=input_file,
        diner_meal_file=args.diner_meals,
        output_dir=args.output_dir,
        procurement_serving=args.procurement_serving,
        diner_or_meal=args.diner_or_meal,
        top_n_drivers=args.top_n,
        region=args.region,
        missing_data_policy=args.missing_data_policy,
    )

    print("\n" + "=" * 60)
    print("FOOD REPORT COMPLETE")
    print("=" * 60)
    print(f"  Client PDF:      {rel_path(results['pdf_path'])}")
    print(f"  Client Excel:    {rel_path(results['client_excel_path'])}")
    print(f"  QA Excel:        {rel_path(results['qa_excel_path'])}")
    print(f"  Manifest:        {rel_path(results['manifest_path'])}")
    print(f"  Log:             {rel_path(results['log_path'])}")
    print(f"  Diagnostics: {len(results['diagnostics'])} findings")
    print(f"  Quality status: {results['quality_status']}")
    for key, val in results["summary"].items():
        print(f"  {key}: {val}")
    print("=" * 60)


if __name__ == "__main__":
    main()
