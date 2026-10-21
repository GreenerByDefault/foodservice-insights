# Runbooks

## Context

Some operations happen by hand in a vendor's dashboard or from a maintainer's shell, and nothing
in the code records how. Three such procedures sit in `.claude/plans/runbooks.md` today, with an
**Open** on where runbooks belong and in what form. `better-stack.md` and `caches-to-supabase.md`
promise entries into that file, `README.md:112` and `docs/architecture.md:78` point at it, and the
database's write guard names one entry by title in its error hint (`012_write_guard.ts:67`). The
repo is public, maintained by a contractor through AI agents, and about to be run part-time by a
technical staff member. The runbooks exist to save that person time on the procedures whose traps
the internet does not know, not to document everything.

This plan supersedes `.claude/plans/runbooks.md`: adopt it under that name, replacing the file.
PR 1 recovers the three existing entries with `git show origin/main:.claude/plans/runbooks.md`.

**It runs beside [`documentation-revamp.md`](documentation-revamp.md)**, which creates `docs/`
(`architecture.md`, `requirements.md`, `typescript.md`), adds a CI link checker
(`scripts/ci/check_doc_links.py`), and leaves runbooks to this plan, saying `docs/` is where they
fit. Either plan's PR 1 may land first: `docs/` with only `runbooks/` in it is fine, and the
revamp's PR 2 rewrites every `docs/architecture.md` reference it finds, so each PR here links whatever
name is on `main` the day it opens. The lines both plans touch, one each: the revamp's PR 3 adds a
"Run it in production" row to the README map (PR 1 here adds `docs/runbooks/` to it), its PR 5
rewrites the secrets **Open** in architecture (PR 3 here resolves it), and its PR 6 marks account
recovery **Open** (PR 4 here resolves it). Whichever lands second adjusts the line.

Facts from the tree (2026-10-20) that shape the design:

- **Every production credential is in the `production` GitHub Environment**, named in
  [`deploy.yml`](../../.github/workflows/deploy.yml), which is the list; two in-flight plans change
  it (`email-provider.md` adds Postmark's token, `production-sign-in.md` removes `SITE_PASSWORD`).
  Seven vendors hold a credential of ours: GitHub, DigitalOcean, Supabase (the `postgres` password,
  the S3 key pair, and two role passwords set by hand), Grafana Cloud, Better Stack, OpenAI, and
  Postmark once it lands. Web deploys on every push to `main` and migrates first; the worker
  deploys only by `workflow_dispatch`. A re-run of an old `deploy-web` run skips itself once `main`
  has moved on. Rollback is from the DigitalOcean dashboard and restores that deployment's env,
  undoing any rotation since (`.do/README.md:18-20`).
- **No vendor console URL appears anywhere in the tree.** `apps/grafana/gcx-cloud.yaml:4` keeps
  the Grafana stack hostname out "of the repo, which is public", and `alerts.md` keeps alert
  addresses in an Environment variable for the same reason.
- **Agents are denied the hosted CLIs**: `doctl`, `gcx`, `gh secret`, `gh workflow run`, hosted
  Supabase (`.claude/settings.json`, widened by `agent-guardrails.md`). A runbook is run by a
  person from their own shell or a vendor's dashboard.
- **House skills never run scripts, and rules are path-scoped pointers**: `db.md` points at
  `packages/db/README.md`; the revamp's PR 7 makes `web.md` point at `apps/web/README.md`. The one
  production-touching script (`temporary-go-live-cache-import/`) is TTY-only, prompts for the
  credential, and `caches-to-supabase.md` PR 2 deletes it, so nothing may link it.
- **`cache_client`'s one password is shared** by every developer and data scientist holding
  `CACHE_DB_CONNECTION_STRING`; `metrics_reader`'s rotation is already written on
  `apps/grafana/scripts/deploy.ts:11-14`; `ALTER ROLE` passes the write guard
  (`012_write_guard.ts:18-19`).
- **What each failure reason means is code** (`packages/db/src/analysis-failure-explanations.ts`,
  a `Record` over the enum), so no runbook lists reasons.
- **`audit_actor_kind` has a `gbd_manual` value nothing writes** (`public-schema.sql:77-82`;
  `audit.ts` writes only `'user'`). The draft's by-hand example promotes a superadmin with no
  audit row.
- **Open items this plan closes:** `runbooks.md`'s own **Open**; `docs/architecture.md:510` (no
  rotation process for suspected leaks); `docs/requirements.md:248-251` (account recovery "TBD");
  the draft token entry's "a fixed expiration rather than none"; `caches-to-supabase.md:69-70`.

## Decisions

### `docs/runbooks/`, one file per runbook, with a README that is the index and the rules

Runbooks cross a vendor UI and at least two components, which the `writing-docs` skill and the
revamp both put in `docs/`. A folder rather than one file because each runbook is read alone,
under some pressure, and a file is what a person opens, links, and searches for by name.

- **File names say what the reader is trying to do, or what happened**: `deploy-the-worker.md`,
  `rotate-a-secret.md`, `a-credential-leaked.md`. Lowercase kebab, like the rest of `docs/`.
- **`docs/runbooks/README.md`** holds what every runbook shares: who they are for and who runs
  them; § Where things are, the vendor table (what we have at each, its entry page plus the
  resource's name, what it holds in a phrase, and that a GBD staff login owns each account with
  the contractor as member); § The runbooks, one line each; and § Writing one, the conventions
  below. The root README's map links the folder under "Run it in production".
- **`.claude/rules/runbooks.md`**, `paths: ["docs/runbooks/**"]`, about eight lines: an agent
  reads or writes a runbook and never performs one; the public-file rule; and a pointer at the
  README's § Writing one. The rule carries the two things an agent must know before it reads
  anything; the README carries the rest, which is the `db.md` pattern.
  *Considered, not done: a bullet in the `writing-docs` skill instead.* The skill loads on the
  model's judgment; a rule loads whenever the path is touched.
- **The heading "Write to the database by hand" is kept byte-for-byte** as the file's title: the
  guard's hint, `public-schema.sql:564` and `write-guard.test.ts:30` name it with no path, on
  purpose (`012_write_guard.ts:58-59`).

### Public, with links to entry pages, never into an account

The folder may name what is already public: app and role names, Environment variable names, the
vendors. Never a credential, a connection string, a person's address, a stack hostname, project
ref, team or app id, or a deep link into a console. A link is the vendor's entry page plus the
resource's name: "cloud.digitalocean.com/apps → `foodservice-insights-web`". That is what
`gcx-cloud.yaml` already decided, and it costs one click over a deep link.
*Considered, not done: deep links to logs and dashboards.* They sit behind sign-in, so the risk
is small, but they are the one thing a public file would add for someone scanning for a Grafana
or Better Stack login page, and a browser bookmark gives the team the same click.

### Writing one: the conventions the README states

- **One procedure per file, and only what the code cannot say**: the dashboard path, the order,
  the trap. `deploy.yml`'s step comments already say what a failed step means;
  `packages/db/README.md` § Writing a migration says a schema may run ahead of code; alert
  thresholds stay on the rules (`alerts.md`); hosted settings stay on `budget.ts`. Link, never
  restate, and copy no number.
- **The shape**: when you would do this, the steps, how you know it worked, and what to do if it
  did not. Five to thirty lines.
- **Run by a person.** Every shell line is one a person types; nothing in a runbook is for an
  agent to execute, and a credential is pasted at a prompt, never on a command line.
- **A procedure another plan owns is written here by that plan's PR**, under the file name this
  plan reserves, so there is one owner per entry.
- **Open questions are `**Open:**` in the entry**, never guessed; a vendor page named in an entry
  was opened while writing it.

### Markdown, not scripts or skills

A person runs these; agents are denied the hosted CLIs by design, so there is nothing for a
skill to execute. Each entry is a few dashboard steps plus at most one shell line. The one
candidate for a script, the marked transaction in "Write to the database by hand", is better as
prose: a script would put the guard's opt-in in committed code, which the hint deliberately
avoids so that an agent stops (`012_write_guard.ts:58-59`).

- **Revisit when** an entry passes about ten shell steps, or someone has run one wrong twice.
  Then the form is the import's: `--production`, refuses without a TTY, prompts for the
  credential, confirms with a typed word.

### Every credential, one file, one shape

`rotate-a-secret.md` opens with the steps every rotation shares (mint the new value; find the
secret's name in `deploy.yml` and `gh secret set <NAME> --env production`, which prompts so the
value stays out of history; redeploy *both* apps, the web by a push or by re-running the latest
`deploy-web` while `main` is still at its commit, the worker by its runbook; only then delete the
old value; a rollback restores the old one). Then one section per credential, in the same
shape: *minted at*, *also moves*, *then*. The DigitalOcean token's section is longer only because
its scopes are a decision made here, not a copy of anything. `cache_client` is a section too,
since it is rotated the same way though it never touches the Environment.

- *Rejected: a file per credential.* Eight files of three lines each, and the shared steps copied
  into each or linked from each.
- *Rejected: a page per vendor.* It would mix reference (where, who owns it) with procedure; the
  README's table is the reference, and this file is the procedure.
- **The DigitalOcean token never expires.** Rotate on a trigger: a suspected leak, the token's
  creator leaving the DigitalOcean team, or a scope change. Its only home is the Environment,
  which only `main` can deploy from, and it updates two apps that already exist; an expiry turns
  into a failed deploy months later, found by whoever pushes next, after the migrate step has
  already run. *Rejected: an expiring token with a calendar reminder.* The reminder lands on a
  part-time maintainer, and a rotation done once a year is where a mis-scoped token comes from.
  What matters is who mints it: a token dies with its creator's team membership, so a GBD staff
  login that will stay on the team creates it. Confirm both vendor facts in DigitalOcean's UI
  while writing.

### What is in, and who writes what other plans promised

| File | Why it earns its place |
| --- | --- |
| `README.md` | The index, the vendor table, the conventions |
| `deploy-the-worker.md` | The one deploy that is by hand, and when it is due |
| `roll-back-a-deploy.md` | Env restored, app pinned, worker must not run ahead; a failed deploy's two lines |
| `write-to-the-database-by-hand.md` | Named by the guard's error hint |
| `review-cache-suggestions.md` | The three UI steps; the rules stay in `caches-to-supabase.md` and the guard |
| `rotate-a-secret.md` | Every credential, where it is minted, what else moves |
| `a-credential-leaked.md` | Closes `docs/architecture.md:510` |
| `offboard-a-person.md` | Crosses every vendor team and two rotations |
| `restore-the-database.md` | Two sentences the vendor's docs cannot say |
| `change-a-users-email.md` | Resolves the REQUIREMENTS TBD; why the dashboard and not SQL |
| `trace-a-problem-through-the-logs.md` | Reserved: `better-stack.md` PR 1 writes it |
| `a-user-did-not-get-an-email.md` | Reserved: `email-provider.md`'s PR writes it |

- `better-stack.md`'s entry already covers the path from a failed attempt's row to its log lines,
  so there is no separate triage file. `email-provider.md` today plans its two support lines into
  architecture § Email; PR 1 redirects it here, and that PR adds Postmark's rows to the vendor
  table and to `rotate-a-secret.md`. `caches-to-supabase.md` links `review-cache-suggestions.md`.
  `alerts.md` adds nothing: the README's one sentence, "an alert's own rule says what firing
  means, then the logs runbook", is the whole of "when an alert fires".
- *Left out:* generic vendor how-tos an agent or a search answers; the hosted project's settings,
  which stay on the code that depends on them; plan tiers, which `scripts/monthly_costs.py` holds;
  a per-reason triage table.

### By-hand changes are audited

`gbd_manual` exists for this. The by-hand example gains one `INSERT INTO audit_event` in the
same marked transaction, `actor_kind = 'gbd_manual'`, with the columns `audit.ts` fills, so the
example doubles as the template for any manual write. The email-change runbook says to record
one the same way. **Open, for Eric:** if that is more ceremony than the trail is worth, PR 4
instead adds a migration dropping the enum value.

## PR 1 — The folder, and what already exists

Branch off `main`. Recover the three entries first:
`git show origin/main:.claude/plans/runbooks.md`.

- **`docs/runbooks/README.md`**: two lines on who they are for and that a person runs them, plus
  the alert sentence above; § Where things are, one row per vendor (GitHub: the repo, the
  `production` Environment, Actions, the GHCR packages; DigitalOcean: the team, the two apps;
  Supabase: the project's database, Auth, Storage and Studio, with Auth settings only in its
  dashboard per `docs/architecture.md:86-89`; Grafana Cloud: the stack, our folder; Better Stack: the
  source, views, monitor; Postmark: the server, two streams; OpenAI: the billing project; GBD's
  Squarespace DNS and Google Workspace), the ownership lines, and "plan tiers:
  `scripts/monthly_costs.py`"; § The runbooks, the three below; § Writing one, from Decisions.
- **`.claude/rules/runbooks.md`**, as in Decisions.
- **`write-to-the-database-by-hand.md`**, verbatim. **`review-cache-suggestions.md`**, cut to the
  three UI steps the code cannot say: filter `is_verified = false` by `created_at`, with
  `suggested_by` saying where a row came from; fix in place and tick; bulk-verify with an
  `UPDATE` in the SQL editor; one line links `caches-to-supabase.md` § Decisions for the rules,
  which that plan's last PR moves here when it deletes itself.
- **`rotate-a-secret.md`**: the shared steps (absorbing `.do/README.md:16-17`, which becomes a
  pointer) and one section, the DigitalOcean token, from the draft with three changes: a first
  line naming the triggers; step 1 says a GBD staff login creates it, and why; step 3 says no
  expiration, with the *Rejected* line. The other sections are PR 3's.
- **Links.** `README.md:112` and its map or § Documentation, whichever is on `main`;
  `docs/architecture.md:78-79` (link the file; "needs no runbook" becomes a link to
  `review-cache-suggestions.md`); `.do/README.md:16-17`. The guard's hint is unchanged.
- **Other plans, one line each:** `better-stack.md:56,118` →
  `docs/runbooks/trace-a-problem-through-the-logs.md`; `caches-to-supabase.md:69-70`;
  `email-provider.md:278-281` → `docs/runbooks/a-user-did-not-get-an-email.md`, plus its rows;
  `documentation-revamp.md`'s "Runbooks are out of scope" bullet names `docs/runbooks/`.
- `/plan-advance` removes this section.

## PR 2 — Deploying

- **`deploy-the-worker.md`.** Actions → Deploy → Run workflow, "Use workflow from" `main`; the
  run prints the commits since the last worker deploy and refuses anything else by itself. When:
  after a change under `apps/worker`, `python/`, `contract/` or `packages/` lands, and after
  rotating a secret the worker holds. In-flight attempts get the drain grace (architecture
  § Worker deploys only on demand); the user retries one that ran out. Check: the new worker's
  `Worker started` log line carries `workerGitSha`.
- **`roll-back-a-deploy.md`.** The policy, one line: revert the PR (architecture § Bad deploys
  are fixed forward). A failed deploy needs no rollback: read the failed step, whose comment in
  `deploy.yml` says what it means and whether to re-run; a failed migrate applied nothing, and a
  failed deploy left the old app running on a schema the migration rules allow. When an outage
  cannot wait: the app's page → Deployments → roll back to the previous one. Then the three lines
  from `.do/README.md:18-20`, which becomes a pointer: it restores that deployment's env and so
  undoes any secret rotated since; a rollback pins the app, so commit or revert it in the
  dashboard before the next deploy; land the revert before the next worker deploy, which would
  otherwise run ahead of the web.
- `/plan-advance` removes this section.

## PR 3 — Secrets and people

- **`rotate-a-secret.md`** gains its remaining sections, each *minted at / also moves / then*:
  - The `postgres` password: Supabase → Project Settings → Database → reset; the Connect dialog's
    string changes with it, and so does what CI migrates with.
  - The Storage S3 key pair: Supabase → Storage → S3 access keys; a new pair, swap, delete the old.
  - The OpenAI key: OpenAI → API keys, in the project the spend is tracked in; worker only.
  - The Better Stack source token: both apps forward with it. **Open, check while writing:**
    whether a source's token can be regenerated or only a new source created.
  - The Grafana service account token: Administration → Service accounts → the deploy account;
    add a token, delete the old; CI only.
  - The `metrics_reader` password: the procedure on `apps/grafana/scripts/deploy.ts`' header,
    linked.
  - The site password, while placeholder mode lasts: at or above `site-password.ts`' minimum;
    signs every browser out. `production-sign-in.md` PR 2 removes the section.
  - `cache_client`, absorbing `caches-to-supabase.md:154-159` before that plan is deleted: compose
    the string in `.env.example`'s form, check it with `psql`, hand it over privately; each holder
    sets `CACHE_DB_CONNECTION_STRING` and runs `just pull-caches` once. Rotate with
    `ALTER ROLE cache_client PASSWORD` in the SQL editor, then re-hand it; until a holder updates,
    their `live` worker and the lab's step 1 refuse to start, by design. That plan's hand-out
    section becomes a pointer.
  - Variables are not secrets; they change only when the resource they name does.
- **`a-credential-leaked.md`.** Rotate it now, before confirming the leak; what else it could
  reach (the `postgres` password takes `cache_client` and `metrics_reader` with it); find where
  it came from, since the Environment cannot be read back, so a leak is a laptop's `.env`, a
  paste, or a vendor; read the logs for what it did meanwhile. Architecture's secrets **Open**
  becomes a pointer here.
- **`offboard-a-person.md`.** Remove them from the GitHub repo and from each vendor's team in the
  README's table; if they created the DigitalOcean token, rotate it under a staff login; if they
  held the `cache_client` string, rotate it; their lab keys are their own. Onboarding is the
  reverse, plus the README.
- `/plan-advance` removes this section.

## PR 4 — Recovery, and the audit line

- **`restore-the-database.md`.** Supabase's docs for the click path, linked. The two sentences
  they cannot say: a migration that landed after the backup is unapplied while the deployed code
  expects it, which the migration rules never allow, so re-run the latest `deploy-web`, or push,
  immediately after; and the blob store is outside the backup, so objects uploaded since stay
  there with no row pointing at them, harmless, while an attempt that was running is `pending`
  again and will be claimed afresh.
- **`change-a-users-email.md`.** GBD verifies the person out of band (they can name their
  organization and recent reports). Then Supabase → Authentication → Users → the user → change
  the email, and why there: `auth.users` is a guarded table, so the SQL editor hits the write
  guard, while the Users page goes through Supabase Auth, which the guard exempts
  (`012_write_guard.ts:11-13,48`). `app_user` holds no email, so nothing else changes. Two
  follow-ups: a pending invite to the old address no longer matches, so re-invite; record the
  change per the audit line. `docs/requirements.md:250-251`, or its **Open** if the revamp's PR 6
  landed first, becomes a link.
- **The audit line** in `write-to-the-database-by-hand.md`, per Decisions: `actor_kind =
  'gbd_manual'`, `action` naming what was done, `actor_user_id` null, `detail` saying who; check
  the columns against `public-schema.sql` and `audit.ts`. Or, if the **Open** resolves the other
  way, a migration dropping the enum value.
- `/plan-advance` deletes this plan.

## Verification

Docs only, so the gates pass trivially. Per PR, by hand:

- **Links resolve.** `python3 scripts/ci/check_doc_links.py` once the revamp's PR 1 lands;
  until then, from the repo root:

  ```sh
  for f in $(git ls-files 'docs/runbooks/*.md' README.md docs/architecture.md .do/README.md docs/requirements.md 2>/dev/null); do
    rg -o '\]\(([^)#]+)' -r '$1' "$f" | rg -v '^https?://' | while read -r p; do
      [ -e "$(dirname "$f")/$p" ] || echo "$f -> $p"
    done
  done
  ```

  And `rg -n 'runbooks\.md' --glob '!.claude/plans/runbooks.md'` finds nothing after PR 1.
- **The guard's hint still matches.** `rg -n 'Write to the database by hand'` shows the file's
  title, the hint in `012_write_guard.ts`, `public-schema.sql` and `write-guard.test.ts`, all
  spelled the same.
- **The rule loads.** In a session, editing a file under `docs/runbooks/` brings
  `.claude/rules/runbooks.md` into context (`/doctor prompt-audit` after PR 1, per README
  § Working with Claude Code).
- **PR 1:** `git show origin/main:.claude/plans/runbooks.md` diffed against the recovered files
  shows only the token section's three changes and the cache entry's cut.
- **PR 3:** each vendor page named was opened while writing; any that could not be checked is
  marked **Open** in the entry. The DigitalOcean no-expiry option and token ownership are
  confirmed in its UI.
- **PR 4:** on the dev stack with `PUBLIC_AUTH_MODE=supabase`, sign in as one address, change it
  in Studio's Auth → Users, sign in with the new address: same `app_user.id`, same reports. Run
  the by-hand example as written: the `audit_event` row appears with `actor_kind = 'gbd_manual'`,
  and the same statements without `set local` are refused.
