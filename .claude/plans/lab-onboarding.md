# Lab onboarding

## Context

Yujia runs GBD's client analyses. She is starting over in this repo rather than porting her
notebooks from the old analysis repo, and she works through an AI agent, so what her agent reads
matters as much as what she reads. Eric meets her in early December 2026.

The plan has two halves. PR 1 fixes what is broken whatever she answers, and lands before the
meeting. § Questions for Yujia holds what only she can decide, and § After the meeting sketches
the PRs that wait on her answers.

### What her first day hits today

Found on 2026-11-23 by reading the runscripts and running their logic. `just test-lab` passes,
but it covers none of these.

- **The lab README says only "give each client a folder".** The setup notebook is the only
  thing that makes the folder layout `detect_client_structure` requires, and the README does not
  send her to it.
- **`just sync` removes the Jupyter kernel.** `ipykernel` is not in the lockfile, so an editor
  that runs `# %%` cells pip-installs it into `.venv`, and the next sync takes it out.

### What PLATE can replace

These are the facts behind question 1.

- **A US procurement file PLATE accepts** (`docs/requirements.md` § File upload) gets the same PDF
  and client workbook from PLATE as from the lab's step 2, which calls the same product code.
- **PLATE's workbook does not say which category each product got.** Only the lab's outputs do.
- **Only the lab handles** serving data and entree detection, Europe's emission factors, PDFs and
  files PLATE would reject, unit cleaning, and the QA workbook.
- **A pilot needs the lab for both periods.** Step 5 reads each period's Raw Data sheet, which
  only the QA workbook has.
- **PLATE caps reports** per user and per organization (`HOURLY_REPORT_LIMIT` and
  `WEEKLY_REPORT_LIMIT`), and a superadmin is not exempt.

## Decisions

- **Fix what is broken; leave the workflow to her.** Everything before the meeting is a bug or a
  gap whichever way she answers. Where her data lives, what PLATE is for, and how her agent works
  are her calls.
- **Client data can live anywhere.** `load_repo_env()` in `notebook_runscript_setup.py` loads
  the repo root's `.env` from `PACKAGE_DIR` rather than the working directory, and every runscript
  and notebook calls it, so a client folder in `client_work/` and one on GBD's Drive both work.
  The setup notebook puts new client folders in `python/lab/client_work/` unless `.env` sets
  `CLIENT_DATA_FOLDER`. That takes question 3 off the critical path. `cache_sync` and
  `model_eval` still walk up from the working directory, which is right for them: they run only
  through `just`, from the repo root.
- **Steps 1 and 2 run from the repo, never from a per-client copy.** They are CLIs with nothing
  to edit per client, so a fix to either reaches every client. Both step 0.5s already launch step 1
  from `get_customer_template_dir()`, with `--no-push-suggestions` set from a `PUSH_SUGGESTIONS`
  variable beside the launch. The setup notebook copies only the runscripts with cells to edit,
  named by `runscripts_for_data_folder()`, and never overwrites a copy the client already has. A
  pilot starts from the baseline's copies where they exist.

## PR 1 — Document a client from clone to report

**Why:** her agent reads the lab README first, and today the README describes neither the folder
layout nor how to run a cell.

**Code:**
- `python/lab/pyproject.toml`: add `ipykernel`.
- Lab README § Working on a client: start a client with the setup notebook, whose layout the
  runscripts require, and run cells with `.venv` as the kernel.
- Lab README: a short § PLATE or the lab, covering § What PLATE can replace above, linking rather
  than restating. Facts only; a default waits on question 1.

**Verify:** in a fresh worktree, follow only the README from `just sync` through step 2 on
`test_data/raw_data/sample_raw_purchasing.csv`, with `--no-push-suggestions` so its made-up names
stay out of the review queue. The file has 255 rows, so the LLM calls cost cents.

## Questions for Yujia

Each question says what its answer changes.

### Where reports get made

1. **Open: What is PLATE for in her work?** Of her current and upcoming clients, which send a US
   procurement file PLATE accepts, and which will reach a pilot? Does she check which category
   each product got before sending a report? When PLATE makes a client's report, whose
   organization is it in: GBD's, or the client's own, so the client can see it?
   *Changes:* the README's default. Using PLATE for baselines would need step 5 to read PLATE's
   client workbook, or PLATE to offer per-product data. Heavy use would need the report caps to
   fit.
2. **Open: Which engagements are midway,** with a baseline from the old repo and a pilot still to
   come? Categorizations have been corrected since then (the pork rule, GBD's cache fixes), so
   re-running a baseline here would change numbers the client has already seen. Nobody has tested
   whether step 5 reads an old QA workbook. *Changes:* whether we re-run those baselines and
   explain the difference, adapt step 5 to the old workbook, or finish those engagements in the
   old repo.

### Her setup

3. **Open: Does client data stay on GBD's Drive, or move to `client_work/`?** Both already
   work. Drive is backed up and shared with colleagues. `client_work/` is where her agent already
   looks and where the repo's rules load, but it exists only on her laptop. *Changes:* the
   default for `CLIENT_DATA_FOLDER`.
4. **Open: Which editor runs her cells, and which agent does she use?** *Changes:* whether to add
   JupyterLab beside `ipykernel`, and whether agent guidance goes in `AGENTS.md`, which most
   agents read, or in `.claude/`, which only Claude Code reads.
5. **Open: What should her agent know when it works on a client?** The old repo's AGENTS.md had a
   procedure for this: copy templates without overwriting, uncomment template code before writing
   new code, mark AI-written cells, check outputs and row counts before calling a run done, and
   report back a fixed list. Here, an agent in `client_work/` gets `.claude/rules/python.md`,
   which is written for product code, and nothing about client work. Which parts still fit how she
   works? *Changes:* a client-work rule or skill, written with her.

### Her part in the codebase

6. **Open: How should her changes to lab code land?** Reviewed PRs like product code, or a
   lighter bar? *Changes:* how fast her fixes reach the shared runscripts.
7. **Open: What would make entree classification ready for the product?** PLATE takes
   procurement only, and entree detection works on serving data through Gemini, which product
   code may not import. Moving it means PLATE accepting serving data, and entree detection
   running on `LlmClient`, measured against the verified entree cache the way `model_eval`
   measures categories. How many clients send serving data? Would she own that eval?
   *Changes:* whether an entree plan starts, and who drives it.

## After the meeting

These are sketches that wait on her answers. Each becomes a `## PR N` once its question is
settled.

- A client-work rule or skill, written with her (questions 4 and 5).
- A default in § PLATE or the lab, plus step 5 reading PLATE's client workbook if she wants PLATE
  for baselines (question 1).
- An entree eval, as its own plan (question 7).

## Verification

For each PR, run `just lint && just check && just test`, plus `TEST_DB=1 just test-lab`. After
PR 1, do the README walk-through in its **Verify**.
