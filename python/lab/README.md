# gbd_foodservice_insights_lab

Where GBD's data scientists run client analyses by hand: the runscripts they copy per client,
and the extraction, unit-cleaning and pilot-analysis helpers those runscripts call.

The lab ships nothing and carries none of the product's guarantees. The worker never installs
it, and nothing we ship may import it —
[`python.md` § The lab boundary](../../.claude/rules/python.md#the-lab-boundary) has the
rule. Code moves into `gbd_foodservice_insights` when the product needs it.

## The pipeline

Each step's runscript is in [`runscripts/`](runscripts/). Steps 0.5, 1.5 and 3 are manual only;
1 and 2 are what the product automates.

| Step | Runscript | What it does |
| --- | --- | --- |
| 0 | `0 setup_folder_structure.ipynb`, `0 initial_data_check.ipynb` | Lay out a client folder; first look at the raw files |
| 0.5 | `0.5 Prepare PDF data.ipynb` *or* `0.5. Prepare tabular data Runscript.py` | Turn the client's PDFs, or messy CSV and Excel files, into one clean CSV. Launches step 1 |
| 1 | `1. Categorize Runscript.py` | Assign every product a GBD category — cache first, then the LLM |
| 1.5 | `1.5. Clean Units Runscript.py` | Normalize weights to kilos or pounds, LLM-assisted. Runs step 2 in-process |
| 2 | `2. Produce Food Report.py` | Emissions, aggregation, and the report bundle — `food_report.pipeline.run_food_report()` wraps the product's in-memory core (or, for serving data, the lab's own `food_report/serving.py`) and writes the rest: chart PNGs, the QA workbook, the run manifest, and the run log |
| 3 | `3. Compare baseline procurement vs serving.py` | Only when a client sent both for the same baseline |
| 5 | `5 pilot_analysis.ipynb` | Pilot vs baseline |

[`test_data/`](test_data/) is an anonymized sample dataset with one input per step, for trying a
change without client data.

## PLATE or the lab

For a US procurement file PLATE accepts
([`requirements.md` § File upload](../../docs/requirements.md#file-upload)), PLATE makes the same
PDF and client workbook as step 2, which calls the same product code. Only the lab:

- shows which category each product got;
- handles serving data and entree detection, Europe's emission factors, PDFs, and files PLATE
  would reject;
- cleans units and writes the QA workbook, which step 5 reads for both periods of a pilot.

PLATE caps reports per user and per organization, superadmins included
([`requirements.md` § Abuse limits](../../docs/requirements.md#abuse-limits)).

**Open:** which one a client's analysis should default to.

## Working on a client

Start each client by running `0 setup_folder_structure.ipynb` from [`runscripts/`](runscripts/).
The runscripts read the client, period and data type from the folder they run in, so they need
the layout it makes. It also copies in the runscripts you edit per client, and never overwrites a
copy you already have. Client folders go in [`client_work/`](client_work/), which git ignores,
unless `CLIENT_DATA_FOLDER` in `.env` says otherwise. Steps 1 and 2 have nothing to edit per
client, so they run from `runscripts/`; each step 0.5 launches step 1.

Run each copied runscript cell by cell from its folder, with the repo's `.venv` as the kernel.
`just sync` installs `ipykernel` there, and the `.py` runscripts mark cells with `# %%`.

The kernel holds whatever lab code it imported, and step 1.5 runs step 2 in that kernel. After
editing lab code, restart the kernel, or run `%load_ext autoreload` and `%autoreload 2` first.

The lab reads three keys from `.env`: `ANTHROPIC_API_KEY` (categorization and PDF extraction),
`GEMINI_API_KEY` (entree detection and extraction), and `LLM_WHISPERER_API_KEY` (PDF
extraction). See [`.env.example`](../../.env.example).

The categorization and entree caches live in the database. To use them:

1. Ask GBD for the `cache_client` connection string, and treat it like an API key. It can
   only read the caches and suggest rows to them.
2. Put it in `.env` as `CACHE_DB_CONNECTION_STRING`, in the form
   [`.env.example`](../../.env.example) shows: its `sslrootcert` is the absolute path to the
   repo's `supabase-ca.crt`. Never put it in `DB_CONNECTION_STRING`.
3. Run `just pull-caches`. It logs how many verified rows it pulled into each of the
   [lab's cache files](gbd_foodservice_insights_lab/data_files/README.md), or why it could not.

From then on, step 1 pulls before it calls any LLM, and stops if it cannot. **A pull overwrites
both files, hand edits included.**

Step 1 suggests its new categorizations and entree labels back to the database. A suggestion is
used by no run until someone verifies it in Supabase Studio; the next pull then brings it down.
The first suggestion of a product wins, so correct an answer in Studio, not in a file, and pass
step 1 `--no-push-suggestions` to keep a prompt experiment's answers out. Each step 0.5 sets it
from `PUSH_SUGGESTIONS` beside its launch of step 1.

Without the string, step 1 warns, sends the LLM whatever the files on disk do not answer, and
suggests nothing.

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
