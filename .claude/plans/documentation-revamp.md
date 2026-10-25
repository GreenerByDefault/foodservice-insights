# Documentation revamp

## Context

The docs' structure dates from the project's first weeks, when the root README was the only
guide and the architecture doc was partly a spec. The product is now built and close to go-live.
The root README is already a front door with a map, and the TypeScript guide is
`docs/typescript.md`; what remains no longer fits:

- **`docs/architecture.md` still carries detail one package owns, and that copy has drifted.**
  § Worker already keeps only the seams, its design now in `apps/worker/README.md` § Design. But
  § Auth, § Input file upload and validation, § Email and § Secrets management each restate one
  package's code, and the copies are wrong in places: `submission.ts` "is imported by the
  browser" (it is not; `inspect-file.ts` is).
- **`docs/requirements.md` has drifted from the product** it now describes: the server "sends requests
  to a Python worker" (it enqueues; the worker pulls), "CSRF protection tokens" (SvelteKit's origin
  check), `HttpOnly` cookies (deliberately not, per docs/architecture.md § Auth), an audit list missing
  five event kinds `apps/web/src/lib/server/audit.ts` records, an expired invite that "does not
  redirect" (it does, for a user with no memberships), country-of-users as a nice-to-have (built
  in #687), and two `TBD`s that should be greppable `**Open:**`.
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
  the section it used to anchor on), `012_write_guard.ts`'s hint naming "Write to the
  database by hand", and the architecture doc's "needs no runbook" line are left for that session. If it
  chooses `docs/runbooks.md`, that fits the rule above.
- **Leave the go-live gaps to the go-live plans.** docs/architecture.md § Stack says Supabase Auth and
  Postmark while production still runs placeholder sign-in and the dropping email stub;
  `production-sign-in.md` and `email-provider.md` make that true within days, and `.do/README.md`
  already says so. Likewise § Alerts, § Logs and § Hosting, which `alerts.md`, `better-stack.md`
  and `custom-domain.md` rewrite: their headings stay, and this plan does not restructure them.
- **Order.** The three PRs touch different files and can land in any order.
- *Rejected: `docs/python.md` beside `docs/typescript.md`.* Symmetric, but it moves the Python
  guide out of the only directory that holds Python.
- *Rejected: keeping ARCHITECTURE.md and REQUIREMENTS.md at the root.* Updating references is
  mechanical, and with them in `docs/` the folder has an obvious charter.

## PR 1 — The rest of docs/architecture.md keeps to cross-component facts

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

## PR 2 — docs/requirements.md matches the product

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

## PR 3 — Package docs, and the code their errors pointed at

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
  too, but not a doc named without `§`, so a later move still wants a `git grep` for the old
  name (`ARCHITECTURE.md` and `REQUIREMENTS.md` now appear only in frozen SQL and the check's
  own tests).
- **Gates.** Every PR: `just lint`, since ruff formats Markdown repo-wide and it runs the doc
  check. PRs that touch TypeScript or package scripts (1, 3): `pnpm lint && pnpm check &&
  pnpm test`, in the background. PRs that touch Python (3): `just lint && just check && just
  test`, and for its marker removal, `--strict-markers` passing confirms nothing used them.
- **Read-through.** Each moved section reads correctly where it landed, with no dangling "above"
  or "below".
