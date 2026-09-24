#!/usr/bin/env python3
# %%
# ruff: noqa: E402
import subprocess  # nosec B404
import sys
from pathlib import Path

import pandas as pd
from dotenv import find_dotenv, load_dotenv

ENV_PATH = find_dotenv(usecwd=True)
load_dotenv(dotenv_path=ENV_PATH)

from gbd_foodservice_insights.report.diagnostics import clean_column_names
from gbd_foodservice_insights_lab.extraction.tabular_inspection import (
    compare_component_datasets,
    detect_component_duplicate_risk,
    identify_low_cardinality_columns,
    raw_data_report,
    suggest_column_roles,
    suggest_date_source_and_coverage,
    suggest_tabular_import_settings,
)
from gbd_foodservice_insights_lab.extraction.tabular_io import (
    extract_dates_from_sheet_filenames,
    read_in_all_data_files,
)
from gbd_foodservice_insights_lab.notebook_runscript_setup import (
    detect_client_structure,
    save_client_metadata,
    setup_pandas_display,
)

setup_pandas_display()

SUB_CLIENT = (
    False  # Did the client send data from multiple sites that that want to be analysed separately?
)

# Dynamically set the client, whether it's baseline or pilot, and whether it is procurement
# or serving.
config = detect_client_structure(has_sub_client=SUB_CLIENT, step="prepare_tabular")
client = config["client"]
baseline_pilot = config["baseline_pilot"]
analysis_context = config["analysis_context"]
procurement_serving = config["procurement_serving"]
sub_client_name = config["sub_client_name"]
base_filepath = config["base_filepath"]
output_file = config["output_file"]
DATA_LOCATION = config["data_location"]

# Save metadata for subsequent steps.
save_client_metadata(config=config, env_path=ENV_PATH, pdf_extracted=False)


# %%
# First step is always to have a look at the data manually, just give it a skim.
# Particularly, do they have the entry "add protein" ? that might been sorting.
#
# Now, regardless of whether they're excel or csv, we want to get data into a
# list of data frames. Then we process each one and stitch them together.
data_type_classification = raw_data_report(
    path=DATA_LOCATION,
    baseline_pilot=baseline_pilot,
    base_filepath=base_filepath,
)
suggest_tabular_import_settings(data_location=DATA_LOCATION)


# %%
# Load data based on detected type.
# Run the appropriate block below based on `data_type_classification`.
if data_type_classification == "single_tab_files":
    # Use read_in_all_data_files for CSVs or multiple single-sheet Excel files.
    # Many procurement Excel files have title rows, subtotal rows, or metadata above the
    # real headers.
    # If the columns look wrong when you preview the data, stop here and set skiprows
    # before doing anything else.
    dfs_to_concat, dataset_names = read_in_all_data_files(data_location=DATA_LOCATION)

    # pd.read_excel("filename.xlsx", sheet_name="Sheet1", usecols="A:C", skiprows=1)
    # If you want to read a specific sheet, specific columns, or skip rows.

    for i, (name, df) in enumerate(zip(dataset_names, dfs_to_concat, strict=True)):
        df = clean_column_names(df=df)
        sheet_filename = name.name
        df["sheet_filename"] = sheet_filename
        dfs_to_concat[i] = df

elif data_type_classification == "single_multitab_excel":
    # Get the Excel file path from raw_data_report with return_dict=True.
    _, file_info = raw_data_report(
        path=DATA_LOCATION,
        return_dict=True,
        max_preview_rows=0,
        baseline_pilot=baseline_pilot,
        base_filepath=base_filepath,
    )
    single_excel_filename = file_info["single_excel_path"]
    if single_excel_filename is None:
        raise ValueError(
            "raw_data_report classified the input as a multi-tab workbook but did not "
            "return its path"
        )

    all_sheets = pd.read_excel(single_excel_filename, sheet_name=None)

    # Filter out specific sheets that you do not want to concatenate.
    SHEETS_TO_IGNORE = None
    assert SHEETS_TO_IGNORE is not None, (
        "Please set the SHEETS_TO_IGNORE variable to a list of sheet names to ignore, or "
        "give an empty list"
    )

    dfs_to_concat = [df for name, df in all_sheets.items() if name not in SHEETS_TO_IGNORE]
    print("Concatenating sheets:", [name for name in all_sheets if name not in SHEETS_TO_IGNORE])

    dataset_names = [name for name in all_sheets if name not in SHEETS_TO_IGNORE]

    for i, (name, df) in enumerate(zip(dataset_names, dfs_to_concat, strict=True)):
        df = clean_column_names(df=df)
        df["original_sheet_name"] = name
        dfs_to_concat[i] = df

else:
    print(
        "I only know how to automatically handle 'single_tab_files(s)' and "
        "'single_multitab_excel' - manual handling required"
    )


# %%
if len(dfs_to_concat) > 1:
    compare_component_datasets(dfs=dfs_to_concat)

component_names = [name.name if hasattr(name, "name") else str(name) for name in dataset_names]
suggest_column_roles(dfs=dfs_to_concat, component_names=component_names)
suggest_date_source_and_coverage(dfs=dfs_to_concat, component_names=component_names)
detect_component_duplicate_risk(dfs=dfs_to_concat, component_names=component_names)


# %%
full_data = pd.concat(objs=dfs_to_concat, ignore_index=True)


# %%
full_data  # noqa: B018  # Hydrogen cell output


# %%
# Define the date column.
# Should we extract the date from the filename or is it already in the data?
EXTRACT_DATE_FROM_FILE_SHEET_NAMES = False
# If the client's date lives in the filename instead of the data itself, map it
# to a real date here. A safe final format is YYYY-MM-DD, or another format that
# pandas can parse consistently.

if EXTRACT_DATE_FROM_FILE_SHEET_NAMES:
    # Extract dates from filenames automatically.
    # This will look at the "sheet_filename" column and try to extract dates.
    # If your filenames only have months (no year), provide default_year parameter.
    full_data = extract_dates_from_sheet_filenames(df=full_data)

    # Verify the extraction worked. You can view the unique filenames and their extracted dates:
    full_data[["sheet_filename", "date"]].drop_duplicates()
else:
    DATE_COL = "month"
    full_data.rename(columns={DATE_COL: "date"}, inplace=True)


# %%
# Optional code to map the `sheet_filename` column to something useful like
# `date` or `category`.
#
# For example, in one client there were different files for Jan, Feb, Mar, so we
# map those filenames to dates. Or in another client they one file for basic
# menu and another for premium menu, so we map those filenames to "basic" and
# "premium". Once we've extracted the information out of the sheet_filename
# column (or not), then we can just drop that column.
# filename_map = {
#     "OLDFILENAME_1.csv": "NEWNAME_1",
#     "OLDFILENAME_2.csv": "NEWNAME_2",
# }
# full_data["SET THIS"] = full_data["sheet_filename"].map(filename_map)


# %%
full_data.drop(columns=["sheet_filename"], inplace=True)


# %%
full_data.head()


# %%
# Rename columns.
#
# Note that if the client sent you weight in multiple columns, for example if
# there is a number of cases and a case weight column, then just set the number
# of cases to being the weight column. We will clean up the weight in a later
# step of the pipeline.
PRODUCT_NAME_COL = "SET THIS"
WEIGHT_COL = "SET THIS"
# clean_column_names() changes the source column names before you set these values.
# Use the cleaned names you actually see in full_data.head(), not the original spreadsheet labels.

full_data.rename(
    columns={
        PRODUCT_NAME_COL: "product",
        WEIGHT_COL: "weight",
    },
    inplace=True,
)

full_data = clean_column_names(df=full_data)


# %%
identify_low_cardinality_columns(df=full_data, threshold=10)


# %%
full_data.head()


# %%
# Drop useless columns.
# full_data.drop(columns=["SET THIS", "SET THIS", "SET THIS"], inplace=True)


# %%
# Print rows where product or weight is missing. These are essential columns, so
# it is important that there are no missing values here or that missing values
# are justified.
full_data[full_data["product"].isna() | full_data["weight"].isna()]
# Step 1 categorization is strict about missing product or weight values.
# Drop these rows, or document why they should be kept, before auto-launching the
# categorization step.
# full_data = full_data[~(full_data["product"].isna() | full_data["weight"].isna())]


# %%
# Lastly, if the client provided a column called "category" or some such, we
# don't want that to mess with the next step, which creates a column called
# category, but we might want to use that information. So we append the
# client-provided category onto the product name.
if "category" in full_data.columns:
    print(
        "The 'category' column already exists in the DataFrame, likely because the client "
        "provided their own categories. Consider removing it before running the "
        "categorization pipeline."
    )

    full_data["product"] = full_data["product"] + " (" + full_data["category"] + ")"
    full_data.drop(columns=["category"], inplace=True)


# %%
assert "SET THIS" not in full_data.columns, (
    "The DataFrame contains a column named 'SET THIS'. Please rename or remove this "
    "column before proceeding."
)


# %%
full_data.to_csv(output_file, index=False)


# %%
# Run step 1 categorization on the CSV produced in this file.
script_path = Path(__file__).resolve().parent / "1. Categorize Runscript.py"
if not script_path.exists():
    raise FileNotFoundError(f"Categorize runscript not found at: {script_path}")

data_type = "serving" if "serving" in procurement_serving.lower() else "procurement"
cmd = [
    sys.executable,
    str(script_path),
    "--input",
    str(output_file),
    "--analysis-context",
    analysis_context,
    "--data-type",
    data_type,
]

print("Running:", " ".join(cmd))
subprocess.run(args=cmd, check=True)  # nosec B603


# %%
# Optional: manually promote reviewed categorizations into the main reviewed cache.
# Only set this to True after manually editing the *_for_human_review.csv file.
from gbd_foodservice_insights.categorization.cache import (
    promote_local_review_file_to_reviewed_cache,
)

PROMOTE_REVIEWED_CATEGORIZATIONS = False
REVIEWED_BY = ""

review_file = Path(str(output_file)).with_stem(
    Path(str(output_file)).stem + "_categorized_for_human_review"
)

if PROMOTE_REVIEWED_CATEGORIZATIONS:
    promotion_summary = promote_local_review_file_to_reviewed_cache(
        review_file=review_file,
        reviewed_by=REVIEWED_BY or None,
    )
    print("Promoted reviewed categorizations:", promotion_summary)
else:
    print("Skipped cache promotion. Review file:", review_file)
