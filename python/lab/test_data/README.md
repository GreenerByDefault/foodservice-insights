# Foodservice Insights Test Data

This directory contains anonymized test datasets for each stage of the foodservice insights analysis pipeline. Each dataset is the **INPUT** to a pipeline step, allowing you to test modifications without accessing client data.

## Purpose

These test datasets allow you to:
- Test pipeline modifications safely without client data
- Develop and debug new features at each step
- Validate data transformations
- Create reproducible tests
- Share examples with collaborators without privacy concerns

## Data Source & Anonymization

**Source:** Based on anonymized institutional catering baseline purchasing data (Oct-Dec 2024)

**Anonymization methods applied:**
- **Product names:** Modified brand names and specifications while preserving food category
- **Dates:** Shifted back by 1 year (2024 → 2023)
- **Quantities:** Added ±25% random noise to `total_amount` and `cases`
- **Sample size:** 250 rows (~22% of original 1,131 rows)
- **Date range:** Oct 2, 2023 - Dec 2, 2023 (3 months)

## Pipeline Structure

```
test_data/
├── raw_data/                           # INPUT to Step 1b
│   └── sample_raw_purchasing.csv       (messy CSV with metadata rows)
│
├── step_1b_output/                     # INPUT to Step 2
│   └── extracted_data.csv              (extracted, some data quality issues)
│
├── step_2_output/                      # INPUT to Step 3
│   └── validated_data.csv              (cleaned & validated)
│
├── step_3_output/                      # INPUT to Step 4
│   └── categorized_data.csv            (with GBD categories)
│
└── step_4_output/                      # Final output
    └── (empty -- see the note on aggregated_baseline.csv below)
```

## Dataset Details

### 1. `raw_data/sample_raw_purchasing.csv`

**Purpose:** Messy raw CSV file as you'd receive from a client

**INPUT TO:** Step 1b (`1b extract_tabular_data.ipynb`)

**Characteristics:**
- **Rows:** 255 (includes 5 metadata header rows at top)
- **Columns:** `date, product, total_amount, weight_lbs, sales, Notes, Internal_ID`
- **Messiness:**
  - First 5 rows contain metadata ("Test University Health System", report title, etc.)
  - Row 6 has alternate header names
  - Empty columns (`Notes`, `Internal_ID`)
  - Actual data starts at row 7

**Usage:**
```python
# Step 1b notebook would skip the metadata rows
df = pd.read_csv("raw_data/sample_raw_purchasing.csv", skiprows=5)
# Then clean up column names, drop empty columns, etc.
```

---

### 2. `step_1b_output/extracted_data.csv`

**Purpose:** Data after extraction from raw file, but before validation

**INPUT TO:** Step 2 (`2 validate_and_clean.ipynb`)

**Characteristics:**
- **Rows:** 250
- **Columns:** `date, product, total_amount, weight_lbs, sales`
- **Known issues (for validation testing):**
  - 2 rows with missing dates
  - 1 row with negative `total_amount` value
  - Some potential duplicates

**Usage:**
```python
# Step 2 would detect and fix these issues
df = pd.read_csv("step_1b_output/extracted_data.csv")

# Validation would catch:
assert df["date"].notna().all()  # FAILS - 2 missing dates
assert (df["total_amount"] > 0).all()  # FAILS - 1 negative value
```

---

### 3. `step_2_output/validated_data.csv`

**Purpose:** Clean, validated data ready for categorization

**INPUT TO:** Step 3 (`3 categorize.ipynb`)

**Characteristics:**
- **Rows:** 248 (2 removed for missing dates)
- **Columns:** `date, product, total_amount, weight_lbs, sales, month_year`
- **Quality:**
  - All dates valid
  - All numeric values positive
  - Column names normalized (lowercase, underscored)
  - `month_year` column added for aggregation

**Usage:**
```python
# Step 3 would categorize these products
df = pd.read_csv("step_2_output/validated_data.csv")

from gbd_foodservice_insights.categorization.pipeline import categorize_products

df_categorized, summary, review_df = categorize_products(
    df=df,
    data_type="procurement",
    openai_client=client,
)
```

---

### 4. `step_3_output/categorized_data.csv`

**Purpose:** Data with GBD food categories assigned

**INPUT TO:** Step 4 (`4 aggregate.ipynb`)

**Characteristics:**
- **Rows:** 248
- **Columns:** `date, product, total_amount, weight_lbs, sales, month_year, category`
- **Categories:** 8 unique (Beef, Poultry, Legumes, Cheese, Fish, Milk, Mayo, etc.)
- **Distribution:**
  - Most items: "No Matches Found" (non-food items like packaging, supplies)
  - Food items properly categorized

**Usage:**
```python
# Step 4 would aggregate by category
df = pd.read_csv("step_3_output/categorized_data.csv")

from gbd_foodservice_insights.report.aggregation import aggregate_data

df_agg = aggregate_data(df, group_by="category", diners_map=your_diner_map, per_diner_meal=True)
```

---

### 5. `aggregated_baseline.csv`

**Purpose:** Final aggregated baseline data ready for reporting

**FINAL OUTPUT** of pipeline

**Location:** `tests/insights/data/aggregated_baseline.csv`, not under
`step_4_output/` -- it is the fixture for
`tests/insights/report/test_integration_food_report.py`, and lives there so
that `tests/insights/` needs nothing outside itself.

**Characteristics:**
- **Rows:** 248
- **Columns:** `date, product, total_amount, weight_lbs, sales, month_year, category, kilos_total`
- **Ready for:**
  - Baseline reports
  - Emissions calculations
  - Comparison with pilot data
- **Note:** `kilos_total` is calculated from `weight_lbs` (1 lb = 0.453592 kg)

**Usage:**
```python
# Use for baseline analysis and reporting
df_baseline = pd.read_csv("../tests/insights/data/aggregated_baseline.csv")

# Generate summary statistics
summary = df_baseline.groupby("category")["kilos_total"].sum()
```

---

## Complete Pipeline Flow

```
┌─────────────────────────────────────────────────┐
│ raw_data/sample_raw_purchasing.csv              │
│ (255 rows, messy with metadata)                 │
└────────────────┬────────────────────────────────┘
                 │
                 ▼ [Step 1b: extract_tabular_data.ipynb]
                 │ - Skip metadata rows
                 │ - Extract clean columns
                 │ - Basic structure
┌────────────────▼────────────────────────────────┐
│ step_1b_output/extracted_data.csv               │
│ (250 rows, has data quality issues)             │
└────────────────┬────────────────────────────────┘
                 │
                 ▼ [Step 2: validate_and_clean.ipynb]
                 │ - Remove invalid rows
                 │ - Normalize columns
                 │ - Add month_year
┌────────────────▼────────────────────────────────┐
│ step_2_output/validated_data.csv                │
│ (248 rows, clean and validated)                 │
└────────────────┬────────────────────────────────┘
                 │
                 ▼ [Step 3: categorize.ipynb]
                 │ - Assign GBD categories
                 │ - Use historical data
                 │ - LLM categorization
┌────────────────▼────────────────────────────────┐
│ step_3_output/categorized_data.csv              │
│ (248 rows, with categories)                     │
└────────────────┬────────────────────────────────┘
                 │
                 ▼ [Step 4: aggregate.ipynb]
                 │ - Calculate weights
                 │ - Add emissions
                 │ - Per-person metrics
┌────────────────▼────────────────────────────────┐
│ tests/insights/data/aggregated_baseline.csv     │
│ (248 rows, ready for reporting)                 │
└─────────────────────────────────────────────────┘
```

## Testing Each Step

### Test Step 1b (Extract Tabular Data)

```python
# Load the messy raw data
df_raw = pd.read_csv("test_data/raw_data/sample_raw_purchasing.csv", skiprows=5)

# Your extraction logic here...

# Compare with expected output
df_expected = pd.read_csv("test_data/step_1b_output/extracted_data.csv")
```

### Test Step 2 (Diagnostics & Clean)

```python
from gbd_foodservice_insights.report.diagnostics import (
    clean_column_names,
    summarise_numeric_columns,
)

# Load data with known issues
df = pd.read_csv("test_data/step_1b_output/extracted_data.csv")

# Run validation
print(f"Missing dates: {df['date'].isna().sum()}")  # Should find 2
print(f"Negative amounts: {(df['total_amount'] < 0).sum()}")  # Should find 1

# Apply cleaning...
df_clean = df.dropna(subset=["date"]).query("total_amount > 0")

# Verify matches expected output
df_expected = pd.read_csv("test_data/step_2_output/validated_data.csv")
assert len(df_clean) == len(df_expected)
```

### Test Step 3 (Categorize)

```python
from gbd_foodservice_insights.categorization.pipeline import categorize_products

# Load validated data
df = pd.read_csv("test_data/step_2_output/validated_data.csv")

# Run categorization
df_cat, summary, review_df = categorize_products(
    df=df,
    data_type="procurement",
    openai_client=your_client,
)

# Compare with expected
df_expected = pd.read_csv("test_data/step_3_output/categorized_data.csv")
```

### Test Step 4 (Aggregate)

```python
from gbd_foodservice_insights.report.aggregation import aggregate_data

# Load categorized data
df = pd.read_csv("test_data/step_3_output/categorized_data.csv")

# Create test diner-meal map
diners_map = {
    pd.Period("2023-10", "M"): 5000,
    pd.Period("2023-11", "M"): 5200,
    pd.Period("2023-12", "M"): 4800,
}

# Aggregate
df_agg = aggregate_data(df, group_by="category", diners_map=diners_map)
```

## Data Characteristics

### Product Distribution
- **Food items:** ~30% (proteins, dairy, produce, grains)
- **Non-food items:** ~70% (packaging, supplies, cleaning products)

### Quantity Ranges
- `total_amount`: $4.84 - $6,639.92
- `weight_lbs`: 0.95 - 233.59 pounds

### Categories Found
- Cheese (7 items)
- Poultry (Chicken & Turkey) (3 items)
- Mayo (4 items)
- Whole Grains (2 items)
- Legumes (1 item)
- Fish & Mollusks (1 item)
- Milk (Cow's milk) (1 item)
- No Matches Found (231 items - mostly non-food)

## Important Notes

⚠️ **Not for Production Analysis**
These datasets are for testing only. Do not use for:
- Actual client reporting
- Emissions calculations for real interventions
- Statistical analysis of food trends

✅ **Safe for Version Control**
All data has been anonymized and is safe to commit to Git repositories.

📊 **Realistic Test Cases**
The datasets preserve realistic scenarios:
- Messy raw input files (metadata, extra columns)
- Data quality issues (missing values, negatives)
- Mix of categorizable and non-categorizable items
- Actual product name patterns from real data

---

**Last Updated:** 2025-11-10
**Generated From:** Anonymized institutional catering baseline purchasing data (Oct-Dec 2024)
**Script Version:** 2.0
