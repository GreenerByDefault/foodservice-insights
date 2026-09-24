#!/usr/bin/env python3
# %%
"""
Interactive baseline procurement vs serving comparison.

This Hydrogen file is meant to read like an analysis walkthrough, not like a
second codebase. It keeps the setup visible and lets the charts do most of the
explaining.

The main purpose is quality checking. A client may send us one data source that
describes what was bought and another that describes what was served or sold.
Those two sources will rarely match perfectly, because they measure different
things in different units, but they should usually tell a broadly similar
category story. This file helps the analyst quickly judge whether they do.

Required inputs (old pipeline artifacts):
    This script compares the multi-tab Excel summary produced by the old pipeline's
    `4 aggregate.ipynb` step. To identify a client that is ready for this comparison,
    look for the following two files (one per side):
        Client work/<client>/baseline/purchasing-procurement data/*_full_summary.xlsx
        Client work/<client>/baseline/sales-serving data/*_full_summary.xlsx
    Both workbooks must contain the sheets: "Monthly Category Data",
    "Template Data", and "Diner Numbers". A client qualifies for this
    comparison only if BOTH workbooks exist.

Instructions for AI agents running this analysis:
    When asked to run this comparison for a client, follow these steps in order.

    1. Identify a qualifying client. Glob the repo for `*_full_summary.xlsx`
       inside BOTH `baseline/purchasing-procurement data/` AND
       `baseline/sales-serving data/`. A client qualifies only if BOTH
       workbooks exist. Candidate clients are typically found under
       `Client work/<client>/baseline/` or `Client work/Pilot Completed/<client>/baseline/`.
       Check the client folders under `Client work/` and `Client work/Pilot Completed/`
       for which clients currently qualify.

    2. Confirm the client choice with the user before writing or executing
       anything. Do not start work on a specific client without permission.

    3. Copy this template into the client's baseline folder using the Write
       tool, NOT `cp` or `mv`. Google Drive sync has been observed to
       occasionally delete files when shell copy/move commands are used, so
       Write is the safer option.

    4. Package install requirement.
       This copied script now assumes the shared package has already been
       installed into the project `.venv`, for example from the
       `catering_analysis/` repo via:
           python -m pip install -e ".[dev]"
       It no longer tries to discover the package on disk with
       `sys.path` manipulation.

    5. Execute the copied script with the active project Python and an
       off-screen matplotlib backend so GUI windows do not block execution.
       In the shared GBD environment, activate the project `.venv` first:
           source .venv/bin/activate
           cd "<absolute path to the client baseline folder>"
           MPLBACKEND=Agg python "3. Compare baseline procurement vs serving.py"

    6. Interpreting output in a non-interactive shell: pandas DataFrames print
       as normal tables, but the plots render as `<IPython.core.display.Image
       object>` rather than inline images. This is expected — the figures are
       generated correctly, they just cannot render visually in a terminal.
       Focus any written report on the textual outputs: month coverage, diner
       or meal number comparison, top share gaps, and top rank gaps.
"""

from __future__ import annotations

import io
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
from gbd_foodservice_insights_lab.notebook_runscript_setup import setup_pandas_display
from gbd_foodservice_insights_lab.procurement_serving_comparison import (
    build_gap_tables,
    compare_diner_numbers,
    compare_month_coverage,
    compare_monthly_categories,
    compare_overall_categories,
    find_baseline_summary_workbooks,
    load_baseline_workbook_data,
    plot_diner_number_comparison,
    plot_monthly_category_share_comparison,
    plot_per_person_share_comparison,
    plot_share_comparison,
    plot_share_scatter,
    split_activity_tables,
    summarize_procurement_serving_comparison,
)
from IPython.display import Image, display

if "__file__" not in globals():
    raise FileNotFoundError(
        "This file needs to be run as a saved Hydrogen file inside "
        "Client Work/{client name}/baseline."
    )

BASELINE_FOLDER = Path(__file__).resolve().parent

# Set notebook-friendly pandas display defaults so tables are readable during
# manual review.
setup_pandas_display()
pd.set_option("display.max_rows", 50)
pd.set_option("display.max_colwidth", 120)


# %%
# Step 1. Confirm which two summary workbooks are being compared.
#
# Before doing any calculations, show the exact workbook names that the helper
# function selected. This prevents a subtle but common mistake where the analyst
# thinks they are comparing one pair of files but the script has picked up
# another similarly named workbook in the same folder tree.
workbook_paths = find_baseline_summary_workbooks(BASELINE_FOLDER)
display(
    pd.DataFrame(
        [
            {
                "dataset": "procurement",
                "file_used": Path(workbook_paths["procurement_workbook_path"]).name,
            },
            {"dataset": "serving", "file_used": Path(workbook_paths["serving_workbook_path"]).name},
        ]
    )
)


# %%
# Step 2. Load the prepared workbook data once so the later cells stay fast.
#
# The loader pulls the specific tabs and category lists that later sections need.
# We do this once up front so we do not repeatedly re-open the same workbooks
# every time we build a table or chart.
loaded_data = load_baseline_workbook_data(
    workbook_paths["procurement_workbook_path"],
    workbook_paths["serving_workbook_path"],
)


# %%
# Step 3. Start with the structural checks before looking at the category plots.
#
# This section answers two basic questions:
# 1. Do the files cover the same months?
# 2. Are the diner or meal counts telling a roughly compatible story?
#
# We do these checks first because later category plots are easier to interpret
# once we know whether the time windows and activity levels line up.
month_coverage = compare_month_coverage(
    loaded_data["procurement_monthly"],
    loaded_data["serving_monthly"],
)
diner_number_comparison = compare_diner_numbers(
    loaded_data["procurement_diners"],
    loaded_data["serving_diners"],
)

print("Month coverage")
if month_coverage["months_match"]:
    # Matching months means month-by-month comparisons later in the file are
    # reasonable. Mismatched months do not make the whole analysis useless, but
    # they do reduce how directly comparable the two sources are.
    print("Procurement and serving cover the same months.")
else:
    print("Procurement and serving do not cover the same months.")

# Show the exact month lists so the analyst can immediately see whether the
# issue is a minor gap, a shifted time period, or a larger extraction problem.
display(
    pd.DataFrame(
        [
            {
                "procurement_months": ", ".join(month_coverage["procurement_months"]),
                "serving_months": ", ".join(month_coverage["serving_months"]),
                "only_in_procurement": ", ".join(month_coverage["months_only_in_procurement"])
                or "(none)",
                "only_in_serving": ", ".join(month_coverage["months_only_in_serving"]) or "(none)",
            }
        ]
    )
)

print("\nDiner or meal numbers")
# `interpretation` is a ready-written summary produced by the shared package.
# It gives a quick plain-English reading of whether the two activity series feel
# broadly aligned or unusually far apart.
print(diner_number_comparison["interpretation"])
display(diner_number_comparison["table"])


# %%
# Step 4. Build the main category comparison outputs.
#
# This is the core comparison build step. It creates:
# 1. an overall category comparison across the full baseline period,
# 2. shorter tables that pull out the most decision-useful gaps, and
# 3. month-level comparisons for later plotting when the month coverage allows.
overall_category_comparison = compare_overall_categories(
    loaded_data["full_comparison_category_list"],
    loaded_data["procurement_monthly"],
    loaded_data["serving_monthly"],
    loaded_data["procurement_template"],
    loaded_data["serving_template"],
    loaded_data["official_gbd_category_list"],
)
activity_tables = split_activity_tables(overall_category_comparison)
gap_tables = build_gap_tables(overall_category_comparison)
monthly_comparisons = compare_monthly_categories(
    loaded_data["full_comparison_category_list"],
    month_coverage,
    loaded_data["procurement_monthly"],
    loaded_data["serving_monthly"],
)

# Gather the main intermediate objects into one dictionary so later plotting and
# summary functions can all read from the same shared structure. This keeps the
# walkthrough cells short and makes debugging easier because the analyst can
# inspect one object rather than many separate variables.
comparison_result = {
    **workbook_paths,
    "official_gbd_category_list": loaded_data["official_gbd_category_list"],
    "extra_client_categories": loaded_data["extra_client_categories"],
    "procurement_non_gbd_categories": loaded_data["procurement_non_gbd_categories"],
    "serving_non_gbd_categories": loaded_data["serving_non_gbd_categories"],
    "month_coverage": month_coverage,
    "months_match": month_coverage["months_match"],
    "months_only_in_procurement": month_coverage["months_only_in_procurement"],
    "months_only_in_serving": month_coverage["months_only_in_serving"],
    "diner_number_comparison": diner_number_comparison,
    "overall_category_comparison": overall_category_comparison,
    "active_only_in_procurement": activity_tables["active_only_in_procurement"],
    "active_only_in_serving": activity_tables["active_only_in_serving"],
    "inactive_in_both": activity_tables["inactive_in_both"],
    "top_share_gaps": gap_tables["top_share_gaps"],
    "top_rank_gaps": gap_tables["top_rank_gaps"],
    "top_per_person_share_gaps": gap_tables["top_per_person_share_gaps"],
    "monthly_comparisons": monthly_comparisons,
}
comparison_result["summary_findings"] = summarize_procurement_serving_comparison(comparison_result)


# %%
# Step 5. Read the plain-English topline before diving into the charts.
#
# These summary lines are intentionally the first interpretation layer. They are
# there to answer, in ordinary language, whether anything looks clearly
# reassuring or clearly worrying before the analyst spends time reading plots.
for line in comparison_result["summary_findings"]:
    print(f"- {line}")

if loaded_data["procurement_non_gbd_categories"]:
    # Category names outside the official list are worth surfacing because they
    # often indicate custom categories, naming drift, or an earlier pipeline
    # step that may need attention.
    print(
        "\nProcurement has category names outside the official GBD list:",
        ", ".join(loaded_data["procurement_non_gbd_categories"]),
    )
else:
    print("\nProcurement has no category names outside the official GBD list.")

if loaded_data["serving_non_gbd_categories"]:
    print(
        "Serving has category names outside the official GBD list:",
        ", ".join(loaded_data["serving_non_gbd_categories"]),
    )
else:
    print("Serving has no category names outside the official GBD list.")

print(
    # Shared inactivity is shown on purpose. If both files agree that a category
    # is absent, that can be a helpful sign of alignment rather than missing
    # information.
    f"{len(activity_tables['inactive_in_both'])} categories are inactive in both files. "
    "That can be a reassuring sign that procurement and serving are telling a similar story."
)

if not activity_tables["active_only_in_serving"].empty:
    # These are categories that have activity on the serving side but no
    # recorded activity on the procurement side. That may be fine in some cases,
    # but it is usually something the analyst will want to inspect.
    print("\nCategories that appear in serving but not procurement")
    display(
        activity_tables["active_only_in_serving"][
            ["category", "serving_total", "serving_share_pct", "serving_rank"]
        ]
    )


# %%
# Step 6. Use the plots to understand the differences.
#
# Each plotting block follows the same pattern:
# 1. ask the shared package to create a Matplotlib figure,
# 2. save that figure into an in-memory PNG buffer,
# 3. display that PNG inline in the notebook, and
# 4. close the figure so we do not leave unnecessary open plots in memory.
#
# Plot 1: Are the two sources telling a similar overall category story?
share_scatter_figure = plot_share_scatter(comparison_result)
share_scatter_buffer = io.BytesIO()
share_scatter_figure.savefig(share_scatter_buffer, format="png", bbox_inches="tight", dpi=150)
share_scatter_buffer.seek(0)
display(Image(data=share_scatter_buffer.getvalue()))
plt.close(share_scatter_figure)

# Plot 2: Which categories have the biggest overall share differences?
# This chart is usually the quickest way to see where one source is materially
# over-representing or under-representing a category compared with the other.
share_gap_figure = plot_share_comparison(comparison_result)
share_gap_buffer = io.BytesIO()
share_gap_figure.savefig(share_gap_buffer, format="png", bbox_inches="tight", dpi=150)
share_gap_buffer.seek(0)
display(Image(data=share_gap_buffer.getvalue()))
plt.close(share_gap_figure)

# Plot 3: Do the diner or meal counts move in a similar way?
# Even if category shares look similar, unusual diner or meal patterns can point
# to missing months, reporting inconsistencies, or other structural issues.
diner_figure = plot_diner_number_comparison(comparison_result)
diner_buffer = io.BytesIO()
diner_figure.savefig(diner_buffer, format="png", bbox_inches="tight", dpi=150)
diner_buffer.seek(0)
display(Image(data=diner_buffer.getvalue()))
plt.close(diner_figure)

# Plot 4: Does the same story hold after adjusting for diners or meals?
# This helps answer whether the category picture stays similar after scaling by
# the number of diners or meals, which can sometimes reveal differences that are
# hidden in simple overall shares.
per_person_figure = plot_per_person_share_comparison(comparison_result)
per_person_buffer = io.BytesIO()
per_person_figure.savefig(per_person_buffer, format="png", bbox_inches="tight", dpi=150)
per_person_buffer.seek(0)
display(Image(data=per_person_buffer.getvalue()))
plt.close(per_person_figure)


# %%
# Step 7. Keep the tables short and focused on the biggest differences only.
#
# The point of these tables is prioritization. A long full comparison table is
# available in the intermediate objects, but for human review it is usually more
# useful to surface the largest gaps first.
print("Largest overall share gaps")
display(
    gap_tables["top_share_gaps"][
        [
            "category",
            "procurement_share_pct",
            "serving_share_pct",
            "share_gap_pct_pts",
        ]
    ]
)

print("\nLargest rank gaps")
# Rank gaps matter because two categories can have fairly close percentage
# shares but still swap order in a way that changes the overall story.
display(
    gap_tables["top_rank_gaps"][
        [
            "category",
            "procurement_rank",
            "serving_rank",
            "rank_gap",
        ]
    ]
)


# %%
# Step 8. Only look at month-by-month plots if the two files cover the same months.
#
# Month-by-month charts are only trustworthy when the month sets match. If one
# side is missing a month, a visual comparison could suggest a category pattern
# problem when the real issue is simply uneven coverage.
if month_coverage["months_match"]:
    print("Month-by-month category plots")
    for month in month_coverage["procurement_months"]:
        # Build one chart per month so the analyst can scan for specific months
        # where procurement and serving diverge more than they do overall.
        print(f"\n{month}")
        monthly_figure = plot_monthly_category_share_comparison(comparison_result, month)
        monthly_buffer = io.BytesIO()
        monthly_figure.savefig(monthly_buffer, format="png", bbox_inches="tight", dpi=150)
        monthly_buffer.seek(0)
        display(Image(data=monthly_buffer.getvalue()))
        plt.close(monthly_figure)
else:
    print("Month-by-month category plots are skipped because the month coverage does not match.")


# %%
# What this notebook does not measure and why:
#
# These notes matter because they protect against over-interpreting the output.
# This file is a diagnostic tool for broad alignment, not a full reconciliation
# tool that proves every row matches perfectly.
#
# 1. It does not compare product names. The goal here is to check whether the
#    broad category story lines up, not whether the same item names appear on
#    both sides.
#
# 2. It does not try to make kilograms numerically equal servings. Those are
#    different units, so the useful comparison is pattern, ranking, and share,
#    not one-to-one totals.
#
# 3. It does not produce a single pass or fail score. This is a diagnostic
#    review tool, so it is meant to support judgement rather than replace it.
#
# 4. It does not compare final PDFs. The useful comparison target is the final
#    Excel summary workbook, because that is where the structured outputs live.
#
# 5. It does not show month-by-month category comparisons when month coverage
#    differs, because that would be misleading.
#
# 6. It does not expose the deeper pipeline steps or intermediate files. The
#    analyst should be able to see the important comparisons without having to
#    wade through the whole analysis pipeline.
#
# 7. Diner or meal numbers are shown as a helpful context check, but exact
#    agreement is not always expected.
#
# 8. Categories missing from both sides are shown on purpose, because shared
#    absence can be a good sign that procurement and serving are broadly aligned.
