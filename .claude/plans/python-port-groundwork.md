# Pre-port groundwork for the Python library port

## Context

[`.claude/plans/python-port.md`](.claude/plans/python-port.md) moves GBD's 24.8k-line closed-source
analysis library into this repo across seven PRs. One of those PRs carries a scattering of
gitignore / CI / prefactor work that PRs 1, 2 and 4 would otherwise have to do inline, inside
diffs that are already enormous copy PRs.

Landing that work first shrinks the copy PRs to what a reviewer actually needs to scrutinize —
"is this the source repo's code, and is it safe to publish."

Precedent: #264 (`requiredContractVersion`), #265 (cap `organization.name` at 100 chars), and this
plan's own now-landed PR (`report.organizationName` in the contract, plus trimming the child's env
allowlist to `PATH, HOME, LANG, TZ, OPENAI_API_KEY`) were all prep of exactly this kind.

---

## PR 1 — Groundwork

Four independent small things. None of them is a behaviour change to the product.

### 1a — Gitignore the caches and the client scratch, before any copying

The port plan's hardest safety requirement is that the three cache CSVs and GBD's client working
directories never enter git. These entries must exist **before** the copy PRs, not in them.

Root [`.gitignore`](.gitignore) gains, near the existing Python block:

```
# Handed out privately; see the data_files READMEs. Never committed.
python/insights/gbd_foodservice_insights/data_files/previously_categorized_items.csv
python/lab/gbd_foodservice_insights_lab/data_files/previously_classified_entrees.csv
python/lab/gbd_foodservice_insights_lab/data_files/previously_classified_weights.csv
.ipynb_checkpoints/
```

Plus three committed files:

- `python/insights/gbd_foodservice_insights/data_files/README.md` and
  `python/lab/gbd_foodservice_insights_lab/data_files/README.md` — what each CSV is, that it is
  obtained out-of-band from GBD, and that a missing file means an empty cache with a warning.
- `python/lab/client_work/.gitignore` containing `*` and `!.gitignore` — the data scientists'
  working directories, present but never committed.

### 1b — Lint the lab in CI, and wire nbstripout

Today a lab-only change is **never linted**: the `python` path filter excludes `python/lab/**`
([`.github/filters.yml:67-72`](.github/filters.yml#L67-L72)), and the `py-lab` job runs only
`just test-lab` ([`ci.yml:231-240`](.github/workflows/ci.yml#L231-L240)). That is a real gap now,
independent of the port.

- Add `just lint` to the `py-lab` job.
- Add `nbstripout` to the root `dev` dependency group; `just lint` gains a verify step and
  `just fmt` the stripping form. **Use a null-safe form** —
  `git ls-files -z '*.ipynb' | xargs -0 -r uv run nbstripout --verify` — because with zero
  notebooks in the repo today, a bare `$(git ls-files '*.ipynb')` gives nbstripout no arguments and
  it blocks reading stdin, hanging CI.
- `uv lock` for the new dev dep.

This is inert until PR 2 of the port drops in four notebooks, which is the point: the check bites
the first time a notebook with outputs is committed rather than after.

### 1c — `errors.py` prefactor

PR 4 of the port needs `AnalysisError` and its three subclasses out of `analysis.py`, because
`llm.py` raises `UpstreamApiError` and importing `analysis` from `llm` would close a
`llm → analysis → categorize` cycle. Doing it now costs three files instead of being buried in
that PR.

- New leaf `python/insights/gbd_foodservice_insights/errors.py` holding `AnalysisError`,
  `UpstreamApiError`, `InvalidInputError`, `UnusableDataError` verbatim from
  [analysis.py:57-70](python/insights/gbd_foodservice_insights/analysis.py#L57-L70).
- `analysis.py` imports and re-exports them, so
  [worker_child/failures.py:11-19](python/worker_child/worker_child/failures.py#L11-L19) and
  `gbd_foodservice_insights/__init__.py` are unchanged. Keep the re-export deliberate (`__all__`
  or an explicit `as` import) so ruff's F401 does not delete it.

### 1d — Doc fix

`ARCHITECTURE.md` and `packages/db/README.md` both link `apps/worker/src/sweeps/reaper.ts`; the
file is `apps/worker/src/sweeps/converge.ts`. Noted at the tail of the port plan; no reason to wait.

---

## Explicitly not done before the port

- **`AnalysisOutcome.metadata` / the `result_metadata` column.** Its shape depends on the ported
  library — [REQUIREMENTS.md:61-65](REQUIREMENTS.md#L61-L65) says so outright, and
  `.claude/plans/categorization-cache.md` already owns the plumbing. Guessing a shape now would be
  a contract change we'd redo.
- **Wiring `WORKER_MODE=mock-llm`.** It needs `worker_child.mock_llm` and `KeywordLlmClient`, which
  do not exist. The named-but-throwing slot in
  [modes.ts:59-64](apps/worker/src/modes.ts#L59-L64) is already the right placeholder.
- **The library's runtime deps (pandas, matplotlib, …) and `uv.lock`.** Unused dependencies would
  bloat the production image and lock versions against nothing.
- **ty overrides and ruff per-file-ignores for ported code.** Which rules fire is only knowable
  once the code is in.
- **Merging the source repo's conventions into `.claude/rules/python.md`.** Documented conventions
  with no code enacting them; the port plan correctly pairs each with its PR.

---

## Verification

From the repo root:

```
pnpm lint && pnpm check && pnpm test
just lint && just check && just test
just test-lab
```

Additionally:

- `git check-ignore -v python/insights/gbd_foodservice_insights/data_files/previously_categorized_items.csv`
  (and the other two) reports the new rule — the cheapest proof the paths are right before any CSV
  exists.
- `git status --ignored` after dropping a dummy CSV at each path shows it ignored;
  `git ls-files | grep '\.csv$'` stays empty.
- Touch a file under `python/lab/` in the PR so the `py-lab` job actually fires and its new
  `just lint` step is observed green.
- Add a throwaway `.ipynb` with a cell output locally and confirm `just lint` fails on it, then
  `just fmt` fixes it. Do not commit the notebook.
