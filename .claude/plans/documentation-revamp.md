# Documentation revamp

## Context

The docs' structure dates from the project's first weeks, when the root README was the only
guide and the architecture doc was partly a spec. The product is now built and close to go-live.
The root README is already a front door with a map, the TypeScript guide is
`docs/typescript.md`, and `docs/architecture.md` keeps to cross-component facts, leaving each
package's detail to that package's doc. What remains no longer fits:

- **Some commands in the docs do not work as written**: `apps/worker/README.md`'s build command
  skips the `@gbd/*` packages it imports; `packages/email/README.md`'s example omits a required
  `reportName`.
- **Small rot elsewhere**: `python/lab/test_data/README.md` (345 lines) describes notebooks and
  step numbers that no longer exist; a few code comments cite doc sections that moved or never
  existed.

Goal: docs a human or agent can find their way through, each fact in the one place the
`writing-docs` skill says it belongs. Where a doc is wrong because the code is awkward, fix the
code.

## Decisions

- **`docs/` holds the docs whose subject no single directory contains**: `docs/architecture.md`,
  `docs/requirements.md`, and `docs/typescript.md`, since the TypeScript code spans `apps/`,
  `packages/` and `tests/`. A doc about code under one directory stays in it, so the Python guide
  stays `python/README.md`, where someone opening `python/` finds it; the root README's Developing
  table gives both stacks equal billing. The `writing-docs` skill states the rule.
- **The root keeps only what tools require or everyone reads first**: `README.md`, `AGENTS.md`,
  `CLAUDE.md`.
- **Lowercase names inside `docs/`.** One reference cannot follow: the SQL body of
  `packages/db/migrations/001_initial_schema.ts:859` (mirrored in `public-schema.sql`) says "See
  ARCHITECTURE.md § Worker queue", and a landed migration's code is never edited
  (`packages/db/README.md` § Writing a migration). So **the heading "Worker queue" keeps its
  name**, and the filename is found by a case-insensitive search.
- **`scripts/ci/check_doc_links.py` checks every move**, in `just lint` and CI's `changes` job:
  Markdown links and `#anchors`, and outside Markdown, `path.md § Heading` citations, whose text
  must begin with the heading in full. A doc named without `§` is not checked, so a move still
  wants a `git grep` for the old name. Nor is a rename of a heading that begins with another
  heading in full: "§ Worker queue" still begins "Worker". A file the check must not read, such as
  a frozen migration, goes in its `UNCHECKED_PREFIXES`.
- **Code that cites a doc moves with it.** Error messages, log lines and the tests asserting them
  (`cache_sync.py`'s `_SETUP_DOC`, the "see the README" messages) are updated in the same PR as
  the section they name, like any other reference.
- **Runbooks are out of scope.** Another session owns `.claude/plans/runbooks.md` and where its
  entries land. The README's link into it (to the plan itself, "once it lands", since #693 dropped
  the section it used to anchor on), `012_write_guard.ts`'s hint and `docs/requirements.md`
  § Superadmin, which both name "Write to the database by hand" by title, and the architecture
  doc's "needs no runbook" line are left for that session. If it chooses `docs/runbooks.md`, that
  fits the rule above.
- **Leave the go-live gaps to the go-live plans.** docs/architecture.md § Stack says Supabase Auth and
  Postmark while production still runs placeholder sign-in and the dropping email stub;
  `production-sign-in.md` and `email-provider.md` make that true within days, and `.do/README.md`
  already says so. Likewise § Alerts, § Logs and § Hosting, which `alerts.md`, `better-stack.md`
  and `custom-domain.md` rewrite: their headings stay, and this plan does not restructure them.
- *Rejected: `docs/python.md` beside `docs/typescript.md`.* Symmetric, but it moves the Python
  guide out of the only directory that holds Python.
- *Rejected: keeping ARCHITECTURE.md and REQUIREMENTS.md at the root.* Updating references is
  mechanical, and with them in `docs/` the folder has an obvious charter.

## PR 1 — Package docs, and the code their errors pointed at

- `python/lab/test_data/README.md`: rewrite to about 20 lines. What the dataset is and how it was
  anonymized, which lab step (by `python/lab/README.md`'s numbering) each file feeds, safe to
  commit, not for client work. Drop the file tree, row counts, and the notebooks that no longer
  exist. `python/lab/README.md`'s "one input per step" matches it.
- `apps/worker/README.md`:
  - Its `WORKER_MODE` table repeats the root README's § Analysis modes and restates
    `src/modes.ts`; keep only what the root's lacks (the timings profile) as a sentence. Its
    § The categorization cache, moved there from the root README, stays.
  - Build with `pnpm turbo run build --filter=@gbd/worker`, which builds the packages it imports.
  - The env table gains `OPENAI_API_KEY` (required by `live`) and `WORKER_GIT_SHA`, and
    `PYTHON_BIN` is unneeded in `off`.
  - § Testing: `config.test.ts` does query the database.
  - Cut the `--watch-path` paragraph to its rule: `pnpm dev` restarts on this package's `src/`
    only, so a dependency change needs a manual restart.
- **Code fix: delete the `slow` and `llm` pytest markers** from `pyproject.toml`, with
  `python/README.md`'s advice to use them. No test carries either, nothing deselects them, so an
  `llm` test would run in `just test` and CI, and `.claude/rules/python.md` already says tests
  never call the network. `python/README.md` also says `just lint` and `just fmt` run
  `nbstripout`.
- `packages/email/README.md`: the `sendEmail` example gains `reportName`.
- `contract/README.md`: stop listing `contract.json`'s keys (the list misses three); say it holds
  every name both sides must agree on.
- `.claude/rules/web.md`: one line pointing at `apps/web/README.md` as this app's design (routes,
  API calls, forms, errors, uploads, auth, writes), the way `db.md` points at `packages/db/README.md`. No
  rule routes an agent there today.
- Comments that cite docs wrongly: `apps/worker/src/attempt/queue.ts:99,110` (`reaper.ts` →
  `sweeps/converge.ts`); `apps/web/e2e/reports/reconnect.e2e.ts:6` ("`README.md` § Routes" →
  `apps/web/README.md`); `apps/web/src/lib/reports/csv/describe/text.ts:28` (bans `Intl` "per the
  README.md", which says no such thing: state the reason in place);
  `apps/web/src/lib/server/files.ts:5-6` (points at a route header that does not explain).
- Left alone: `.do/README.md`'s "until `email-provider.md` wires up Postmark", which that plan's
  PR rewrites within days.
- From the end-of-phase audit (2026-10-25), each a line or two:
  - `python/README.md`: `just test` runs `scripts/ci/tests` too; `OPENAI_API_KEY` is read from
    the process, and only the worker parent and the lab load `.env` (calling `analyze()` from a
    shell needs it exported); link `python/insights/README.md`; name `scripts/profile_report.py`
    as the measurement `python.md`'s "do not optimize without a measurement" asks for.
  - `python/insights/README.md`'s "see its README": the lab's `food_report/` has no README; point
    at `python/lab/README.md` § The pipeline.
  - `.claude/rules/contract.md` `paths`: add `python/worker_child/worker_child/run.py`,
    `writer.py` and `python/worker_child/tests/support/contract_fixtures.py`, which write and read
    the contract documents.
  - `.claude/skills/writing-docs/SKILL.md`: the root also holds `CLAUDE.md`.
  - `.claude/skills/plan-advance/SKILL.md`: the register example is `*Rejected: …*` and
    "Considered, not done", which plans use; none uses "Accepted:".
  - `apps/web/e2e/README.md` § Screenshots: record the Git LFS decision, which today lives only in
    the deleted `visual-testing.md`. Measured 2026-10-21: 168 PNGs, 1,626 PNG blobs over 75
    commits, about 52 MB of a 60 MB pack. Not LFS (bandwidth quotas, CI checkout setup, and it
    cannot shrink history). New trigger: a clone noticeably slow, or the pack past about 500 MB.
    The coming redesign will regenerate every image at least once, so prune the set to screens
    with real visual risk before it, as the README already asks.

## Verification

- **Links.** `scripts/ci/check_doc_links.py` passes. It covers comment citations too, but not a
  doc named without `§`, so a move still wants a `git grep` for the old name (`ARCHITECTURE.md`
  and `REQUIREMENTS.md` now appear only in frozen SQL and the check's own tests).
- **Gates.** `just lint && just check && just test`, and for the marker removal,
  `--strict-markers` passing confirms nothing used them. `pnpm lint && pnpm check && pnpm test`
  in the background, for the TypeScript comments and package scripts.
- **Read-through.** Each rewritten doc reads correctly on its own, with no dangling "above" or
  "below".
