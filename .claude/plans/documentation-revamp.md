# Documentation revamp

## Context

The docs' structure dates from the project's first weeks, when the root README was the only
guide and ARCHITECTURE.md was partly a spec. The product is now built and close to go-live, and
the structure no longer fits:

- **The root README is 413 lines, and its bottom 240 are the TypeScript developer guide.** The
  Python guide lives in `python/README.md`, so every reader, Python ones included, scrolls past
  one stack's guide, and the docs map sits in the middle where nobody looks for it.
- **ARCHITECTURE.md (587 lines) carries detail one component owns, and that copy has drifted.**
  § Worker opens with "The detail in this section moves to `apps/worker/README.md` when that
  package lands", long after it landed, while `apps/worker/README.md` points back at it. Most of
  § Worker and § Progress, leases, and reaping restates `apps/worker/src/failures.ts`,
  `config.ts` and `sweeps/converge.ts` nearly verbatim, and the copies are now wrong in places:
  "whenever a child fails in any way, the parent marks the attempt failed" (a cancel kill gives
  `canceled`, a fenced one writes nothing, `attempt/verdict.ts`), "probably 2 workers"
  (`.do/worker.yaml` runs 1), and `submission.ts` "is imported by the browser" (it is not;
  `inspect-file.ts` is).
- **REQUIREMENTS.md has drifted from the product** it now describes: the server "sends requests
  to a Python worker" (it enqueues; the worker pulls), "CSRF protection tokens" (SvelteKit's origin
  check), `HttpOnly` cookies (deliberately not, per ARCHITECTURE § Auth), an audit list missing
  five event kinds `apps/web/src/lib/server/audit.ts` records, an expired invite that "does not
  redirect" (it does, for a user with no memberships), country-of-users as a nice-to-have (built
  in #687), and two `TBD`s that should be greppable `**Open:**`.
- **Some commands in the docs do not work as written**: `pnpm test:db:clean` without `TEST_DB=1`
  cleans the dev stack, where no test databases exist; `pnpm exec playwright show-trace` fails
  from the root; `apps/worker/README.md`'s build command skips the `@gbd/*` packages it imports;
  `packages/email/README.md`'s example omits a required `reportName`.
- **Small rot elsewhere**: `python/lab/test_data/README.md` (345 lines) describes notebooks and
  step numbers that no longer exist; `python/README.md` sends readers to a "repo layout" the root
  README does not have; a few code comments cite doc sections that moved or never existed.

Goal: docs a human or agent can find their way through, each fact in the one place the
`writing-docs` skill says it belongs, and a root README that is a front door with a map. Where
a doc is wrong because the code is awkward, fix the code.

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
  the section it used to anchor on), `012_write_guard.ts`'s hint naming "Write to the
  database by hand", and ARCHITECTURE's "needs no runbook" line are left for that session. If it
  chooses `docs/runbooks.md`, that fits the rule above.
- **Leave the go-live gaps to the go-live plans.** ARCHITECTURE § Stack says Supabase Auth and
  Postmark while production still runs placeholder sign-in and the dropping email stub;
  `production-sign-in.md` and `email-provider.md` make that true within days, and `.do/README.md`
  already says so. Likewise § Alerts, § Logs and § Hosting, which `alerts.md`, `better-stack.md`
  and `custom-domain.md` rewrite: their headings stay, and this plan does not restructure them.
- **Order.** PR 1 first, since every later PR edits the moved files. After that, PR 2, PRs 3–4,
  and PR 5 are independent; PR 3 precedes PR 4 (both edit `docs/architecture.md`), and PR 6 goes
  last (it edits `apps/worker/README.md` after PRs 2 and 3). PR 1 touches the in-flight plans by
  one line each, a trivial conflict for whichever session lands second.
- *Rejected: `docs/python.md` beside `docs/typescript.md`.* Symmetric, but it moves the Python
  guide out of the only directory that holds Python.
- *Rejected: keeping ARCHITECTURE.md and REQUIREMENTS.md at the root.* Updating references is
  mechanical, and with them in `docs/` the folder has an obvious charter.

## PR 1 — Move ARCHITECTURE.md and REQUIREMENTS.md into docs/

A pure move, so review is a rename plus reference updates and later PRs edit the new paths.

- `git mv ARCHITECTURE.md docs/architecture.md`, `git mv REQUIREMENTS.md docs/requirements.md`.
  Inside them, change only relative links (one level deeper) and each other's names, so
  `git diff -M` shows near-100% renames.
- Rewrite every reference: `git grep -n 'ARCHITECTURE\.md\|REQUIREMENTS\.md'` finds about 45 in
  code comments, config and CI comments, 5 in skills, 20 in plans, 25 in other docs. Prose
  becomes `docs/architecture.md § X`; Markdown links get the right relative depth. Fix the one
  broken path, `packages/db/tests/analysis-attempt.test.ts:829` (`../../` → `../../../`). Skip the
  frozen SQL body and its generated mirror, and add `001_initial_schema.ts` and
  `public-schema.sql` to `check_doc_links.py`'s `UNCHECKED_PREFIXES`, since both cite
  `ARCHITECTURE.md`.
- `AGENTS.md`: the two lines naming them. `CLAUDE.md` is untouched (`@AGENTS.md`).
- `.claude/skills/writing-docs/SKILL.md`: its description and links, and the `docs/` bullet
  rewritten to the rule in Decisions: root holds README and AGENTS; `docs/` holds what no single
  directory contains (product intent, the seams between components, the TypeScript guide);
  everything else lives with its code.
- The in-flight plans' references (`alerts.md`, `better-stack.md`, `custom-domain.md`,
  `email-provider.md`, `production-sign-in.md`, `caches-to-supabase.md`), so they point at the
  new paths when they land.
- **Needs Eric's OK, CI again:** `.github/filters.yml` adds `'!docs/**'` to
  `docs_and_agent_files`. Without it, a docs-only PR runs the `ts` and `system` jobs, because
  `!*.md` matches only the root. `deploy.yml`'s two comments citing ARCHITECTURE.md also change.
  `scripts/ci/check_filters.py` requires the new exclusion to match a tracked file, which it will.

Other sessions' branches that edit ARCHITECTURE.md rebase onto the rename; git follows it.

## PR 2 — The root README becomes a front door; the TypeScript guide moves to docs/typescript.md

**`README.md`** (~170 lines), in this order:

1. What the product is (as today).
2. **Run the app locally**: Prerequisites, First time, Start it, Analysis modes, Signing in for
   real, as today, less § The categorization cache (below).
3. **The two databases**: dev vs test, `TEST_DB=1`, always `scripts/supabase`. It stays here
   because both stacks use it: the lab's database tests need the test stack too.
4. **Developing**: the stack table, now TypeScript → `docs/typescript.md`, Python →
   `python/README.md`, and AGENTS.md for how code is written and verified; then § Working with
   Claude Code, unchanged.
5. **Where to find things**, the map regrouped by question rather than one 19-row list:
   - *Understand it*: `docs/requirements.md`, `docs/architecture.md`.
   - *Work on it*: `docs/typescript.md`, `python/README.md`, `AGENTS.md`.
   - *Each component*: one row per package or app README, as today.
   - *Run it in production*: `.do/README.md`, `apps/grafana/README.md`.
6. **What CI runs**: that a PR runs only the jobs its changes can affect, per
   `.github/filters.yml`, and the merge queue. Drop "a TypeScript-only change skips every Python
   job, and vice versa", which is not true (migrations run `python_lab`; Python runs `system`).

Within the README, say the Mailpit and Studio URLs once each (today three times and twice).

**`docs/typescript.md`** (new, ~210 lines): the root README's § TypeScript (Setup, Everyday
commands, Uploading reports by hand, Testing, Tests and the database, Occasional tasks), opening
with one line naming it the counterpart of `python/README.md`. Fixed on the way:

- `pnpm --filter @gbd/web exec playwright show-trace <zip>`, and drop "on failure" from the CI
  report (the e2e and system jobs upload one on every run).
- `pnpm test` is `test:unit` then `test:playwright`, not "Everything": it leaves out
  `test:system` and Python.
- To scope a task to one package, `pnpm turbo run <task> --filter=<pkg>`, not
  `pnpm --filter <pkg> <task>`, which skips `^build` (the trap `.claude/rules/typescript.md`
  names).
- Seeding: Grafana's vitest setup also clones and seeds a run database, so "only Playwright
  seeds" goes; after a truncate it is `seed:identity` alone, matching § Reset a database.
- `REPORT_RATE_LIMIT=off` is already `.env.example`'s value.
- § Screenshots shrinks to a pointer at `apps/web/e2e/README.md`, which already has
  `screenshots:update` and `test:browser:stop`. § Tests and the database stays one line per rule,
  each pointing at the package README that owns it.

**Code fix: `pnpm test:db:clean` targets the test stack, with or without `TEST_DB=1`.** It only
ever makes sense there (`packages/db/scripts/clean.ts`'s header says so), so
`packages/db/package.json`'s `db:clean` script sets `TEST_DB=1` itself, and the header's usage
line stays true.

**§ The categorization cache → `apps/worker/README.md`**, as a section after its env var table,
whose `CACHE_DB_CONNECTION_STRING` row it expands. It configures the worker's `live` mode, which
only some developers run. The README's `live` row links it.

**References**: `#reset-a-database` (`packages/db/README.md`) and § Tests and the database
(`python/lab/tests/conftest.py`) → `docs/typescript.md`; `tests/e2e/README.md`'s `/etc/hosts`
pointer → `docs/typescript.md` § Setup; the categorization cache (`.env.example`,
`caches-to-supabase.md`) → `apps/worker/README.md`; `.claude/rules/typescript.md` ("README.md
covers what to run, and its testing table…") and `Justfile:1` → `docs/typescript.md`;
`AGENTS.md`'s TypeScript "Getting started" cell → `docs/typescript.md`; `python/README.md`'s
opening, which promises a repo layout → "running the app, the local databases, and the docs map".
The runtime "see the README" messages (`apps/web/src/lib/server/env.ts`, `packages/core/src/env.ts`,
`packages/email/src/testing/global-setup.ts`) are about `.env` and starting the stacks, which stay
in the root README. `production-sign-in.md` PR 2 names "the root README" for sign-in, which also
stays there.

## PR 3 — Worker detail moves out of docs/architecture.md

**`docs/architecture.md` § Worker keeps the seams**, about 40 lines where there are 160:

- Only the parent touches the database and blob store; the child reads and writes a run directory,
  whose contract is `contract/`.
- The result email comes from a separate sweep (`sweeps/notifications.ts`), and a canceled
  attempt gets none.
- The reaping race, and that every write to an attempt tolerates it (`packages/db/README.md`
  § The analysis attempt state machine), kept as is.
- § Canceling, kept: it spans web, worker, database and every reader of `status`.
  Name the pending-attempt sweep correctly (`sweeps/converge.ts`).
- § Concurrency and scaling shrinks to the API-load product and its database-connection cost,
  naming `maxConcurrentAttempts` and `WORKER_INSTANCES` (`packages/db/src/budget.ts`) rather than
  "up to 3" and "probably 2 workers".

**`apps/worker/README.md` gains § Design**: what no code comment holds yet. The two-axes table
(child liveness on the filesystem and the parent's clock; supervisor authority in Postgres and
the database's clock), the one renewal rule, the four defenses as a list naming where each lives
(`config.ts`, `sweeps/converge.ts`), and *Rejected: writing the child's progress timestamp into
the database*. Its opening stops pointing at ARCHITECTURE for the design.

**Cut rather than moved**, because the code already says it: the parent lifecycle steps (the
headers of `attempt/lifecycle.ts`, `contract/layout.ts`, `attempt/verdict.ts`), the renewal
corollaries and thrown-renewal cases (`failures.ts`), and the reaper's own-`worker_id` rejection
(`sweeps/converge.ts`).

**Fixed on the way:**

- `apps/worker/src/config.ts:43` says `directIntervalMs` mirrors "child progress into the
  database", against the rejected design; it renews the lease.
- *Rejected: `asyncio` inside `gbd_foodservice_insights`* moves onto `LLM_CONCURRENCY` in
  `python/insights/gbd_foodservice_insights/categorization/llm.py`, beside the concurrency comment
  already there.
- § Worker deploys only on demand gains the seam it never names: `WORKER_CONTRACT_VERSION` and
  `required_contract_version` (`apps/worker/src/attempt/queue.ts`) are how a newer web app keeps an
  older worker from claiming work it cannot do.
- § Worker queue says "workers wait `queuePollIntervalMs` after a poll that starts nothing"
  instead of "every 1–2 seconds". Heading unchanged.

## PR 4 — The rest of docs/architecture.md keeps to cross-component facts

Each section whose subject is one package moves to that package's doc, leaving a line and a
pointer; nothing in § Alerts, § Logs or § Hosting changes.

- **§ Web app**: drop the SSR/CSR paragraph (SvelteKit's default, in no way ours); keep Kysely,
  which both apps use.
- **§ Auth → `apps/web/README.md` § Auth**: the CSP paragraph and the `getClaims()` **Open**. The
  section keeps two lines and the pointer; `apps/web/README.md`'s link back for the CSP becomes a
  link within the file.
- **§ Input file upload and validation → `apps/web/README.md` § Uploads** (new), fixed: the
  browser imports `inspect-file.ts`, which shares `csv/normalize.ts` and `limits.ts` with
  `submission.ts`; the server can reject a workbook, as `too_large` or `unparseable`, with no
  workbook-specific reason; the "10MB" becomes `upload-limit.js`'s constant. What stays in
  architecture is the seam: the web server fully validates before the blob store, so the worker
  trusts its input. The three code comments citing the section move with it.
- **§ Email**: drop the testing paragraph (`packages/email/README.md` § Testing) and the
  backoff detail and due-row list (`sweeps/notifications.ts`'s header, which also has the
  soft-deleted condition the doc's list lacked). The at-least-once trade-off moves into that
  header, the one thing the code does not say.
- **§ Secrets management**: drop the runtime-config paragraph, a third copy of `apps/web/src/env.ts`'s
  header and § Images. The rotation **Open** becomes "**Open:** a process for a suspected leak";
  rotating is `.do/README.md`'s.
- **§ Components**: add `apps/grafana` and `contract/`, and name `apps/worker`.
- **§ Failure modes**: rows promising alerts that do not exist yet ("attempts waiting too long",
  "failing attempts exceed a threshold") say **Open:**, per `alerts.md`'s rule that docs never
  promise an alert; the "gave up" query names `maxNotificationAttempts` instead of `5`.
  `alerts.md` rewrites these rows when the alerts land.
- **§ Data model**: the coordination-point sentence and the pointer; `packages/db/README.md`
  § The model is the fuller copy.
- **§ File links**: drop "we can add download metrics later".

## PR 5 — docs/requirements.md matches the product

- § Processing: the server enqueues an attempt and a worker pulls it.
- § File upload: a workbook may have many sheets; `apps/web/src/lib/reports/excel/sheets.ts`
  picks which one is read.
- § Roles: rows for retrying one's own report, and any report in the org (creator-or-admin, as
  `lib/server/reports/guards.ts` checks).
- § Superadmin: set by hand in the SQL editor through the write guard, naming the runbook entry
  "Write to the database by hand" by title, as the database's own error hint does.
- § Invite flow: an expired invite does redirect a user who belongs to no organization
  (`_organizationsPageRedirect`).
- § Audit trail: state the intent (who can see what, and every destructive action), name
  `apps/web/src/lib/server/audit.ts` as the list, and say no authentication events are recorded.
- § Security: SvelteKit's origin check, not CSRF tokens; cookies `Secure` and `SameSite`, and not
  `HttpOnly`, for the reason in `docs/architecture.md` § Auth.
- § Metrics: country of users is built; keep its privacy constraint as the requirement.
- `**Open:**` for the landing page (a draft exists; GBD's copy and design are pending) and
  account recovery (no script or runbook decided).
- The opening's spec-era instruction ("When implementing … replace these docs with a link")
  becomes the standing rule: a limit lives in code, and this file names its constant.

## PR 6 — Package docs, and the code their errors pointed at

- `python/lab/test_data/README.md`: rewrite to about 20 lines. What the dataset is and how it was
  anonymized, which lab step (by `python/lab/README.md`'s numbering) each file feeds, safe to
  commit, not for client work. Drop the file tree, row counts, and the notebooks that no longer
  exist. `python/lab/README.md`'s "one input per step" matches it.
- `apps/worker/README.md`:
  - Its `WORKER_MODE` table repeats the root README's and restates `src/modes.ts`; keep only what
    the root's lacks (the timings profile) as a sentence.
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
  API calls, forms, errors, auth, writes), the way `db.md` points at `packages/db/README.md`. No
  rule routes an agent there today.
- Comments that cite docs wrongly: `apps/worker/src/attempt/queue.ts:99,110` (`reaper.ts` →
  `sweeps/converge.ts`); `apps/web/e2e/reports/reconnect.e2e.ts:6` ("`README.md` § Routes" →
  `apps/web/README.md`); `apps/web/src/lib/reports/csv/describe/text.ts:28` (bans `Intl` "per the
  README.md", which says no such thing: state the reason in place);
  `apps/web/src/lib/server/files.ts:5-6` (points at a route header that does not explain).
- Left alone: `.do/README.md`'s "until `email-provider.md` wires up Postmark", which that plan's
  PR rewrites within days.

## Verification

- **Links.** `scripts/ci/check_doc_links.py` passes after every PR. It covers comment citations
  too, but not a doc named without `§`, so after PR 1 `git grep` for each old name
  (`ARCHITECTURE.md`, `REQUIREMENTS.md`) finds only the frozen SQL comment.
- **PR 1:** `git diff -M --stat main` shows both files as renames at 95% or more.
  `python3 scripts/ci/check_filters.py` passes.
- **PR 2:** with the test stack up, create a leftover by hand (`CREATE DATABASE fsi_test_manual`
  as `supabase_admin` on port 65322); `pnpm test:db:clean` with no `TEST_DB` drops it, and so
  does `TEST_DB=1 pnpm test:db:clean` on a second one.
- **Gates.** Every PR: `just lint`, since ruff formats Markdown repo-wide and it runs the doc
  check. PRs that touch TypeScript or package scripts (1, 2, 3, 6): `pnpm lint && pnpm check &&
  pnpm test`, in the background. PRs that touch Python (3, 6): `just lint && just check && just
  test`, and for PR 6's marker removal, `--strict-markers` passing confirms nothing used them.
- **Read-through.** Each moved section reads correctly where it landed, with no dangling "above"
  or "below"; the root README renders on GitHub with the map visible without much scrolling.
