# gbd_foodservice_insights_lab

Where GBD's data scientists run client analyses by hand: the runscripts they copy per client,
and the extraction, unit-cleaning and pilot-analysis helpers those runscripts call.

The lab ships nothing and carries none of the product's guarantees. The worker never installs
it, and nothing we ship may import it — [`python.md` § The lab boundary](../../.claude/rules/python.md)
has the rule. Code moves into `gbd_foodservice_insights` when the product needs it.

## The pipeline

Each step's runscript is in [`runscripts/`](runscripts/). Steps 0.5, 1.5 and 3 are manual only;
1 and 2 are what the product automates.

| Step | Runscript | What it does |
| --- | --- | --- |
| 0 | `0 setup_folder_structure.ipynb`, `0 initial_data_check.ipynb` | Lay out a client folder; first look at the raw files |
| 0.5 | `0.5 Prepare PDF data.ipynb` *or* `0.5. Prepare tabular data Runscript.py` | Turn the client's PDFs, or messy CSV and Excel files, into one clean CSV. Launches step 1 |
| 1 | `1. Categorize Runscript.py` | Assign every product a GBD category — cache first, then the LLM |
| 1.5 | `1.5. Clean Units Runscript.py` | Normalize weights to kilos or pounds, LLM-assisted. Launches step 2 |
| 2 | `2. Produce Food Report.py` | Emissions, aggregation, and the report bundle |
| 3 | `3. Compare baseline procurement vs serving.py` | Only when a client sent both for the same baseline |
| 5 | `5 pilot_analysis.ipynb` | Pilot vs baseline |

[`test_data/`](test_data/) is an anonymized sample dataset with one input per step, for trying a
change without client data.

## Working on a client

Work in [`client_work/`](client_work/), which git ignores. Give each client a folder, copy in
the runscripts you need with `cp -n` so you never overwrite edits, and run them cell by cell
from the client's data folder. The runscripts read `client_metadata.json` from the working
directory, and find the repo root's `.env` by walking up from it.

The lab reads three keys from `.env`: `OPENAI_API_KEY`, `GEMINI_API_KEY`, and
`LLM_WHISPERER_API_KEY` (PDF extraction only). See [`.env.example`](../../.env.example).

The categorization, entree and weight caches are handed out privately; ask GBD for them. Each
`data_files/README.md` names the ones that belong in that package —
[product](../insights/gbd_foodservice_insights/data_files/README.md),
[lab](gbd_foodservice_insights_lab/data_files/README.md). Without them everything still runs,
with every item going to the LLM.

## Conventions

- **Intermediate files are CSV**, never parquet — datasets are small.
- **Name every intermediate file for its client, period, data type and step**, e.g.
  `acme_baseline_procurement_categorized.csv`.
- **Run `just fmt` before committing a notebook**; it strips outputs, and `just lint` fails on
  any notebook that still has them.

## Broken client data

Client data comes from catering managers and ESG staff, not data specialists. Expect:

- **Junk header rows** — merged-cell metadata above the real header, which often starts on row
  5 or 6. Inspect the first ten rows before trusting row 0.
- **Amount and unit in one cell**, inconsistently: `4/5 LBS`, `42 EA`, `1000 grammes`. This is
  why step 1.5 exists.
- **Weight split across columns**, or **embedded in the product name** (`Chicken Breast 5lb bag`)
  with no weight column at all.
- **Month-only dates** such as `Jun 2024` or `04/2025`.

Whatever the shape, a step that silently drops or overwrites rows is the worst outcome. Assert
row counts and fail loudly.
