#!/usr/bin/env python3
# %%
import json
import subprocess  # nosec B404
import sys
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from gbd_foodservice_insights.utils import rel_path
from gbd_foodservice_insights_lab.clean_product_weights import (
    convert_products_to_kilograms,
)
from gbd_foodservice_insights_lab.notebook_runscript_setup import (
    get_customer_template_dir,
    load_client_metadata,
    setup_api_clients,
    setup_pandas_display,
    update_metadata,
)

setup_pandas_display()

# Load metadata saved from step 1.
config, ENV_PATH, PDF_EXTRACTED = load_client_metadata(step="clean_units")
load_dotenv(dotenv_path=ENV_PATH)

clients = setup_api_clients(openai=True, gemini=True)
OpenAI_client = clients["openai_client"]
gemini_client = clients["gemini_client"]

client = config["client"]
procurement_serving = config["procurement_serving"]
sub_client_name = config["sub_client_name"]
base_filepath = config["base_filepath"]
input_file = config["input_file"]
output_file = config["output_file"]


# %%
df = pd.read_csv(input_file)
print(f"\n✓ Loaded {len(df):,} rows and {len(df.columns)} columns")
print(f"Columns: {list(df.columns)}")
df.head()


# %%
UNITS_COL = "pack_size"
# PACK_SIZE_COL = "SET THIS"


# %%
# If the units and weight are all in the same cell, for example "4/5lb" or
# similar, run the code below. The function returns a mapping table that
# connects each original messy unit string to its cleaned unit and extracted
# weight, along with example products and success statistics.
# weights, weight_stats = extract_weight_units_pipeline(
#     df=df,
#     units_column=UNITS_COL,
#     product_name_column="product",
#     gemini_client=gemini_client,
# )
# print(weight_stats)


# %%
# Optional: test weight and unit extraction on individual items.
# If you need to manually test what the LLM extracts from any particular unit
# string, use `check_weight_unit_extraction()` to see the cleaned unit and
# extracted weight.
# test_str = "16 oz"
# _ = check_weight_unit_extraction(test_str, gemini_client)


# %%
# Now manually skim the cleaned weights file and note mistakes, improve the
# prompt, and so on.
# weights = pd.read_csv("hand_cleaned_units_extracted_weights.csv")


# %%
# expand_historical_weight_classifications(weights)


# %%
# df = df.merge(weights, how="left", left_on=PACK_SIZE_COL, right_on="original_unit")
# df.drop(columns=["original_unit", "example_products", "previously_classified"], inplace=True)
# df.head()


# %%
# df[df["llm_extracted_weight"].isna()]


# %%
# df = df.dropna(subset=["llm_extracted_weight"])


# %%
# If weight is already clean, you might only have to convert pounds to kilos and
# multiply by number of cases.
# ----------------------------------------------------------------------
# TEMPLATE: Use this block if the weight column is already clean and just needs unit conversion
# ----------------------------------------------------------------------
# If the file already gives total pounds shipped for each row, you usually do not
# need the pack-size logic below. For procurement data like this, you can often
# go straight to kilos_total = weight * 0.453592.
# WEIGHT_COL = "SET THIS"
# if procurement_serving == "purchasing-procurement data":
#     df2["kilos"] = df2[WEIGHT_COL] * 0.453592  # if in lbs


# %%
# Custom code for messy pack sizes.
# Everything below this heading is an example for one client with messy
# pack sizes. Skip this whole block unless your data has a pack_size-style field
# that really needs unpacking.

# Define the regex pattern for the expected pack_size format.
pattern = r"^\d+\s*x\s*\d+\s*x\s*[\d\.]+\s*(kg|l|g|ml)$"

# Find rows where pack_size does NOT match the pattern, case-insensitive.
invalid_pack_size_rows = df[~df[UNITS_COL].str.strip().str.lower().str.match(pattern, na=False)]

invalid_pack_size_rows.drop_duplicates(subset=[UNITS_COL])


# %%
df.loc[df["product"] == "Burgers Spicy Bean Av100g", "pack_size"] = "1 x 1 x 1.8kg"
df.loc[df["product"] == "Butter Coins Unsalted 10g", "pack_size"] = "1 x 2 x 1kg"
df.loc[df["product"] == "Tuna Supremes 140-170g", "pack_size"] = "1 x 1 x 1.86kg"
df.loc[df["product"] == "Eggs Hard Boiled FR Av63g", "pack_size"] = "1 x 1 x 3.024kg"
df.loc[df["product"] == "Eggs Medium Free Range Av51g", "pack_size"] = "1 x 1 x 3.06kg"
df.loc[df["product"] == "Eggs Medium Av51g", "pack_size"] = "1 x 1 x 9.18kg"
df.loc[df["product"] == "Milk Semi Skimmed", "pack_size"] = "1 x 1 x 11.36L"
df.loc[df["product"] == "Dairy Milk Standard 45g", "pack_size"] = "1 x 1 x 45g"


# %%
# Extract units and calculate total weight or volume.
# Extract only the units, the letters, at the end and ignore any preceding numbers.
df["units"] = df["pack_size"].str.extract(r"[\d\.]+\s*([a-zA-Z]+)$")

# Extract the three numbers into separate columns.
df[["pack_n1", "pack_n2", "pack_n3"]] = (
    df["pack_size"].str.extract(r"(\d+)\s*x\s*(\d+)\s*x\s*([\d\.]+)").astype(float)
)

# Calculate the product of the three numbers.
df["total_pack_weight"] = df["pack_n1"] * df["pack_n2"] * df["pack_n3"] * df["weight"]
df.drop(columns=["pack_n1", "pack_n2", "pack_n3"], inplace=True)
df.rename(columns={"weight": "n_packs"}, inplace=True)


# %%
df["total_pack_weight"]


# %%
# Check for problematic weights.
df[df["total_pack_weight"].isna() | df["total_pack_weight"] < 1]


# %%
# If the client did not provide total weight but instead provided number of
# cases and case weight, you should multiply them together.
# ----------------------------------------------------------------------
# TEMPLATE: Use this block if the client provided separate case count and case weight columns
# ----------------------------------------------------------------------
# CASE_WEIGHT_COL = "SET THIS"
# df2["kilos_total"] = df2["kilos"] * df2[CASE_WEIGHT_COL]


# %%
# If the data had messy units that we cleaned in step 1, we can convert the
# weight to kilos now that we have the category.
df.head()


# %%
df = df[df["product"] != "Tomato Beef Summer Av200g BB"]


# %%
# In the original analysis it only needed:
# df = convert_products_to_kilograms(
#     df=df,
#     unit_column_name="units",
#     weight_column_name="total_pack_weight",
#     category_column_name="category",
# )
# then df["kilos_total"] = df["kilos"] * df["quantity"]
if procurement_serving == "purchasing-procurement data":
    df = convert_products_to_kilograms(
        df,
        unit_column_name="units",
        weight_column_name="total_pack_weight",
        category_column_name="category",
    )
    # Multiply per-unit kilos by quantity ordered to get total kilos.
    print(f"✓ Converted to kilograms. Total weight: {df['kilos_total'].sum():,.1f} kg")
    df.head()


# %%
# Save cleaned data and update metadata for step 2.
df.to_csv(output_file, index=False)
print(f"✓ Saved {len(df):,} rows to {rel_path(output_file)}")

# Update metadata so 2. Produce Food Report auto-detects this file.
update_metadata({"report_input_file": output_file})


# %%
diners_map = {
    # TODO: Fill in monthly diner or meal counts, for example:
    # "2024-01": 5000,
    # "2024-02": 4800,
}


# %%
# Auto-launch step 2 from the runscripts folder, not copied per-client.
template_dir = get_customer_template_dir()
next_script = template_dir / "2. Produce Food Report.py"

# Write diners_map dict to a temp JSON so the CLI script can read it.
diner_meals_cli_path = Path(base_filepath) / "_diner_meals_from_notebook.json"
with open(diner_meals_cli_path, "w", encoding="utf-8") as f:
    json.dump(diners_map, f, indent=2)
print(f"✓ Wrote diner-meals JSON to: {rel_path(diner_meals_cli_path)}")

cmd = [
    sys.executable,
    str(next_script),
    "--input",
    str(output_file),
    "--diner-meals",
    str(diner_meals_cli_path),
]

print(f"Launching: {next_script.name}")
result = subprocess.run(cmd, cwd=str(next_script.parent))  # nosec B603
if result.returncode != 0:
    raise RuntimeError(f"Step 2 failed with return code {result.returncode}")

print("✓ Step 2 completed successfully")
