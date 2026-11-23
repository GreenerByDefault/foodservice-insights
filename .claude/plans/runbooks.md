# Runbooks

## Context

Some operations happen by hand in a vendor's dashboard or from a maintainer's shell, and nothing
in the code records how. The repo is public, maintained by a contractor through AI agents, and
about to be run part-time by a technical staff member. The runbooks exist to save that person time
on the procedures whose traps the internet does not know, not to document everything.

[`docs/runbooks/`](../../docs/runbooks/README.md) exists: its README holds the vendor table
(§ Where things are), the index (§ The runbooks) and the conventions (§ Writing one), and
[`.claude/rules/runbooks.md`](../rules/runbooks.md) loads on the folder. In it:
`write-to-the-database-by-hand.md`, whose title and GitHub URL the write guard's hint names
(`019_write_guard_hint_links_runbook.ts`), so moving it needs a migration;
`review-cache-suggestions.md`; `deploy-the-worker.md`; `trace-a-problem-through-the-logs.md`;
`offboard-a-person.md`; and `rotate-a-secret.md`, which covers every credential, including the two
outside the Environment (`cache_client` and Postmark's `auth` SMTP token), and opens with what to
do when one may have leaked. Architecture's secrets **Open** is resolved into a link to it. Each PR
below adds its file's line to the README's § The runbooks.

**Opens left in landed runbooks, to check by hand in the vendor's UI:** DigitalOcean's no-expiry
option and that a token dies with its creator's team membership (`rotate-a-secret.md` §
`DIGITALOCEAN_ACCESS_TOKEN` states both as fact); whether a Better Stack source's token can be
regenerated; where GBD keeps the `cache_client` string between handoffs.

`docs/` holds what no single directory contains, and `scripts/ci/check_doc_links.py` checks every
link and `§` citation. The one line left for this plan: the account recovery **Open** in
`docs/requirements.md` § Account recovery, which PR 1 resolves.

Facts from the tree that shape the design:

- **Bad deploys are reverted, never rolled back** (architecture § Bad deploys are fixed forward).
  Web deploys on every push to `main` and migrates first; the worker deploys only by
  `workflow_dispatch`. A re-run of an old `deploy-web` run skips itself once `main` has moved on.
- **No vendor console URL appears anywhere in the tree.** `apps/grafana/gcx-cloud.yaml:4` keeps
  the Grafana stack hostname out "of the repo, which is public".
- **Agents are denied the hosted CLIs**: `doctl`, `gcx`, `gh secret`, `gh workflow run`, hosted
  Supabase (`.claude/settings.json`). A runbook is run by a person in a vendor's dashboard.
- **`audit_actor_kind` has a `gbd_manual` value nothing writes** (`public-schema.sql`; `audit.ts`
  writes only `'user'`). The by-hand runbook's example promotes a superadmin with no audit row.
- **`auth.users` is a guarded table, and Supabase Auth is exempt** from the guard, because the
  check is on `session_user` (`012_write_guard.ts`, header and the `GUARDED_TABLES` list).

## Decisions

### `docs/runbooks/`, one file per runbook, with a README that is the index and the rules

Runbooks cross a vendor UI and at least two components, which the `writing-docs` skill puts in
`docs/`. A folder rather than one file because each runbook is read alone, under some pressure,
and a file is what a person opens, links, and searches for by name. File names say what the
reader is trying to do, or what happened, in lowercase kebab.

- **The README's vendor table lists only what exists.** A plan that adds a vendor resource adds
  its row.
- **`.claude/rules/runbooks.md`** carries the two things an agent must know before it reads
  anything — it never performs a runbook, and the public-file rule — and points at the README for
  the rest, which is the `db.md` pattern.
  *Considered, not done: a bullet in the `writing-docs` skill instead.* The skill loads on the
  model's judgment; a rule loads whenever the path is touched.

### Public, with links to entry pages, never into an account

The folder may name what is already public: app and role names, Environment variable names, the
vendors. Never a credential, a connection string, a person's address, a stack hostname, project
ref, team or app id, or a deep link into a console. A link is the vendor's entry page plus the
resource's name. That is what `gcx-cloud.yaml` already decided, and it costs one click over a deep
link.
*Considered, not done: deep links to logs and dashboards.* They sit behind sign-in, so the risk
is small, but they are the one thing a public file would add for someone scanning for a Grafana
or Better Stack login page, and a browser bookmark gives the team the same click.

### Writing one

The README's § Writing one holds the conventions. What it leaves to the writer: `deploy.yml`'s
step comments already say what a failed step means; `packages/db/README.md` § Writing a migration
says a schema may run ahead of code; alert thresholds stay on the checks (`data-alerts.md`); hosted
settings stay on `budget.ts`. **A procedure another plan owns is written by that plan's PR**,
under the file name this plan reserves, so there is one owner per entry.

### Markdown, not scripts or skills

A person runs these; agents are denied the hosted CLIs by design, so there is nothing for a
skill to execute. Each entry is a few dashboard steps, with a shell line only where no
dashboard can do the step. The one candidate for a script, the marked transaction in "Write to
the database by hand", is better as prose: a script would put the guard's opt-in in committed
code, which the hint deliberately avoids so that an agent stops (`012_write_guard.ts`, the
comment above `require_marked_writer`).

- **Revisit when** an entry passes about ten shell steps, or someone has run one wrong twice.
  Then the form is the import's: `--production`, refuses without a TTY, prompts for the
  credential, confirms with a typed word.

### What is in

| File | Why it earns its place |
| --- | --- |
| `restore-the-database.md` | Two sentences the vendor's docs cannot say |
| `change-a-users-email.md` | Resolves the requirements TBD; why the dashboard and not SQL |

- *Rejected: a separate `a-credential-leaked.md`.* A leak's response is a rotation plus three
  lines, and the reader under pressure opens "rotate a secret" anyway; it is that file's first
  section.
- No triage file: `trace-a-problem-through-the-logs.md` covers a failed attempt's path to its log
  lines, and the README's Postmark row covers an email that never arrived. No `data-alerts.md`
  runbook: the README's opening line, "its rule says what firing means; then trace the problem
  through the logs", is the whole of it.
- *Left out:* generic vendor how-tos an agent or a search answers; the hosted project's settings,
  which stay on the code that depends on them; plan tiers, which `scripts/monthly_costs.py` holds;
  a per-reason triage table, since `packages/db/src/analysis-failure-explanations.ts` is that.

### By-hand changes are audited

`gbd_manual` exists for this. The by-hand example gains one `INSERT INTO audit_event` in the
same marked transaction, `actor_kind = 'gbd_manual'`, with the columns `audit.ts` fills, so the
example doubles as the template for any manual write. The email-change runbook says to record
one the same way. **Open, for Eric:** if that is more ceremony than the trail is worth, PR 1
instead adds a migration dropping the enum value.

## PR 1 — Recovery, and the audit line

- **`restore-the-database.md`.** Supabase's docs for the click path, linked. The two sentences
  they cannot say: a migration that landed after the backup is unapplied while the deployed code
  expects it, which the migration rules never allow, so re-run the latest `deploy-web`, or push,
  immediately after; and the blob store is outside the backup, so objects uploaded since stay
  there with no row pointing at them, harmless, while an attempt that was running is `pending`
  again and will be claimed afresh.
- **`change-a-users-email.md`.** GBD verifies the person out of band (they can name their
  organization and recent reports). Then Supabase → Authentication → Users → the user → change
  the email, and why there: the SQL editor hits the write guard on `auth.users`, while the Users
  page goes through Supabase Auth, which the guard exempts. `app_user` holds no email, so nothing
  else changes. Two follow-ups: a pending invite to the old address no longer matches, so
  re-invite; record the change per the audit line. The account recovery **Open** in
  `docs/requirements.md` becomes a link.
- **The audit line** in `write-to-the-database-by-hand.md`, per Decisions: `actor_kind =
  'gbd_manual'`, `action` naming what was done, `actor_user_id` null, `detail` saying who; check
  the columns against `public-schema.sql` and `audit.ts`. Or, if the **Open** resolves the other
  way, a migration dropping the enum value.
- `/plan-advance` deletes this plan.

## Verification

Docs only, so the gates pass trivially. By hand:

- **Links resolve.** `python3 scripts/ci/check_doc_links.py`, which CI also runs.
- **The guard's hint still matches.** `git grep -n 'Write to the database by hand'` shows the
  file's title, the hint in `019_write_guard_hint_links_runbook.ts`, `public-schema.sql` and
  `write-guard.test.ts`, all spelled the same, and the hint's URL still opens the file.
- On the dev stack, sign in as one address, change it in Studio's Auth → Users, sign in with the
  new address: same `app_user.id`, same reports. Run the by-hand example as written: the
  `audit_event` row appears with `actor_kind = 'gbd_manual'`, and the same statements without
  `set local` are refused.
