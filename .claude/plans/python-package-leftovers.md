# Python package leftovers

## Context

From the end-of-phase audit, product packages only, re-checked against `main` on 2026-10-25:

- **`PyPDF2` is the deprecated name** of `pypdf` (renamed in 2022; 3.x is its last line). It is a
  dev dependency of `python/insights` for `tests/report/test_pdf.py:41`, and the lab uses it in
  `extraction/pdf.py:43` and two tests. Dependabot will keep it current but never offer the
  rename, and the `PdfReader` API is the same in `pypdf`.
- **Seven `# ty: ignore[invalid-argument-type]` in `tests/report/test_pdf.py`** (180, 215, 237,
  253, 566, 591, 745) all pass a `_RecordingPdf` fake where `PdfPages` is the annotation. A
  `Protocol` naming the methods the page writers call would type the fake and remove all seven.
- **Three copies of an `AnalysisRequest` builder**: `_request()` in
  `python/insights/tests/test_analysis.py:58`, `python/insights/tests/test_testing.py:23` and
  `python/worker_child/tests/test_testing.py:34`. `gbd_foodservice_insights/testing.py` already
  ships `stub_analysis` for exactly this cross-package use.
- **The `cleanup_plt` autouse fixture is defined twice**: `tests/test_plotting_utils.py:27` and
  `tests/report/plots/conftest.py:10`. The matplotlib environment (`MPLBACKEND`, `MPLCONFIGDIR`)
  is set only in `python/insights/tests/conftest.py`, while `python/worker_child/tests/
  test_mock_llm.py` also runs `analyze()` and renders.
- **`tests/test_package.py`** asserts only that the package imports, which every other test
  proves.
- **Two docstrings describe a module that no longer exists.** `utils.py:1-5` claims "file I/O
  helpers, progress reporting, concurrency, and environment detection" and holds
  `print_progress` and `map_concurrently`; `testing.py:53` says "so the port landing won't change
  what it expresses", from the porting phase.

## Decisions

- **One PR, no module moves.** The deleted `notebook-era-leftovers.md` rejected moving
  `emissions.py`, `plotting_utils.py` and `schema.py` as cosmetic, and the lab imports them; that
  stands. The large modules (`report/pdf.py` 975 lines, `report/checks.py` 787) have visible seams
  but no reader asking for a split; `python/insights/README.md`'s table already routes a change
  to the right function. Split one when it next changes for another reason.
- **The lab's two `PyPDF2` imports change in the same PR**, although the lab is otherwise out of
  scope: the rename is three import lines, and leaving them would keep two PDF libraries in
  `uv.lock` for one job.
- **The request builder ships in `testing.py`** as `a_request(**overrides)`, beside
  `stub_analysis`, so `worker_child`'s tests import it the way they import `stub_analysis`. The
  `TID251` carve-out for `**/testing.py` already allows it.
- **The matplotlib test environment moves to `python/conftest.py`**, which with
  `--import-mode=importlib` and `testpaths = ["python"]` applies to every package's tests, and
  the duplicate `cleanup_plt` goes with it. *Rejected: a shared pytest plugin.* One file.
- **The `Protocol` is the writers' real parameter type.** `write_report_pdf`'s page helpers
  take a `PdfPages`; the fake proves they use only `savefig` (and whatever else the Protocol
  names), which is a fact worth having in the signature.

## PR 1 — Tests and docstrings

- `python/insights/pyproject.toml` and `python/lab/pyproject.toml`: `pypdf` in place of `PyPDF2`;
  the four import lines; `uv lock`.
- `report/pdf.py`: a `PdfSink` Protocol (name to taste) for the page helpers;
  `tests/report/test_pdf.py` drops the seven ignores.
- `gbd_foodservice_insights/testing.py`: `a_request()`; the three test files use it.
- `python/conftest.py`: the matplotlib env and `cleanup_plt`; delete the two copies.
- Delete `python/insights/tests/test_package.py`.
- `utils.py` header and `testing.py:53`: say what is true.
- Delete this plan.

## Verification

`just lint && just check && just test`, then `TEST_DB=1 just test-lab` for the lab's import
change. The golden fixture does not change. `pytest --strict-markers` already runs; the test
count before and after is identical minus the one deleted file.
