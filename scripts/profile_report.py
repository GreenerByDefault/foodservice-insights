#!/usr/bin/env python3
"""Profile building a report from an upload at the row cap.

    uv run python scripts/profile_report.py [--rows N] [--top N]

Runs what `analyze()` runs after categorization — `build_food_report`, the charts, the PDF and
the workbook — on synthetic rows under `cProfile`, then prints each stage's wall time, the
PDF's page count, and the most expensive functions. Categorization is left out: it is the LLM
and the cache, not the report.

The rows default to `MAX_DATA_ROWS` (`apps/web/src/lib/reports/limits.ts`) and are seeded, so
two runs see the same data. Weights are log-normal, which gives every category a long tail for
the outlier checks to find, as a real export's does. Timings are only as good as the machine is
idle: check `uptime` first.
"""

from __future__ import annotations

import argparse
import cProfile
import pstats
import re
import tempfile
import time
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from pathlib import Path

import numpy as np
import pandas as pd
from gbd_foodservice_insights.categories import category_names
from gbd_foodservice_insights.report.excel import write_client_workbook
from gbd_foodservice_insights.report.food_report import build_food_report, build_report_charts
from gbd_foodservice_insights.report.pdf import write_report_pdf

MAX_DATA_ROWS = 500_000
PRODUCT_COUNT = 25_000
MONTHS = pd.period_range("2025-01", "2025-12", freq="M")
DINERS_PER_MONTH = 30_000


def synthetic_rows(row_count: int, seed: int = 0) -> pd.DataFrame:
    """Rows shaped like what `analyze()` hands `build_food_report`."""
    rng = np.random.default_rng(seed)
    categories = np.array(category_names())
    product_ids = rng.integers(PRODUCT_COUNT, size=row_count)
    start = MONTHS[0].start_time
    days = (MONTHS[-1].end_time - start).days + 1
    return pd.DataFrame(
        {
            "date": start + pd.to_timedelta(rng.integers(days, size=row_count), unit="D"),
            "product": pd.Series(product_ids).map("Product {:05d}".format),
            "category": categories[product_ids % len(categories)],
            "kilos_total": rng.lognormal(mean=1.0, sigma=1.0, size=row_count).round(3),
        }
    )


@contextmanager
def timed(stage: str, timings: dict[str, float]) -> Iterator[None]:
    start = time.perf_counter()
    yield
    timings[stage] = time.perf_counter() - start


def pdf_page_count(path: Path) -> int:
    # matplotlib writes the page tree's dictionary uncompressed; the root's count comes last.
    return int(re.findall(rb"/Count (\d+)", path.read_bytes())[-1])


def build_deliverables(rows: pd.DataFrame, output_directory: Path) -> dict[str, float]:
    timings: dict[str, float] = {}
    with timed("build_food_report", timings):
        report = build_food_report(
            rows,
            diner_meal_mapping={month: DINERS_PER_MONTH for month in MONTHS},
            region="us",
            diner_or_meal="diner",
            top_n_drivers=5,
        )
    with ExitStack() as stack:
        with timed("charts", timings):
            charts = stack.enter_context(build_report_charts(report))
        with timed("write_report_pdf", timings):
            write_report_pdf(
                report,
                charts,
                output_directory / "report.pdf",
                client_name="Profile",
                show_quality_successes=False,
            )
    with timed("write_client_workbook", timings):
        write_client_workbook(report, output_directory / "report.xlsx")
    return timings


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rows", type=int, default=MAX_DATA_ROWS)
    parser.add_argument("--top", type=int, default=25, help="functions to list by cumulative time")
    args = parser.parse_args()

    rows = synthetic_rows(args.rows)
    profiler = cProfile.Profile()
    with tempfile.TemporaryDirectory() as directory:
        output_directory = Path(directory)
        start = time.perf_counter()
        timings = profiler.runcall(build_deliverables, rows, output_directory)
        total = time.perf_counter() - start
        page_count = pdf_page_count(output_directory / "report.pdf")

    print(f"{len(rows):,} rows, {rows['product'].nunique():,} products\n")
    for stage, seconds in timings.items():
        print(f"{stage:<24}{seconds:>8.1f} s")
    print(f"{'total':<24}{total:>8.1f} s   (under cProfile, so slower than a real run)")
    print(f"\nPDF pages: {page_count}\n")
    pstats.Stats(profiler).sort_stats("cumulative").print_stats(args.top)


if __name__ == "__main__":
    main()
