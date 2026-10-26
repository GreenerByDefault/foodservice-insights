# Runbooks

## Context

Some operations happen by hand in a vendor's dashboard or from a maintainer's shell, and nothing
in the code records how. The repo is public, maintained by a contractor through AI agents, and
about to be run part-time by a technical staff member. The runbooks exist to save that person time
on the procedures whose traps the internet does not know, not to document everything.

[`docs/runbooks/`](../../docs/runbooks/README.md) exists: its README holds the vendor table
(§ Where things are), the index (§ The runbooks) and the conventions (§ Writing one), and
[`.claude/rules/runbooks.md`](../rules/runbooks.md) loads on the folder. Three runbooks are in:
`write-to-the-database-by-hand.md`, whose title and GitHub URL the write guard's hint names
(`019_write_guard_hint_links_runbook.ts`), so moving it needs a migration; `review-cache-suggestions.md`;
`deploy-the-worker.md`; and `rotate-a-secret.md`, which holds the steps every rotation
shares (its step 3 and the DigitalOcean check link the worker runbook) and one section, the DigitalOcean token. The root README
links the folder from § Documentation and from § Signing in for real; architecture and
`.do/README.md` link the files. Each PR below adds its file's line to the README's § The runbooks.

**The documentation revamp has landed**, and left runbooks to this plan. `docs/` holds what no
single directory contains (`architecture.md`, `requirements.md`, `typescript.md`), so
`docs/runbooks/` fits it, and `scripts/ci/check_doc_links.py` checks every link and `§` citation
these PRs add. The folder is in the README map's "Run it in production" table. The lines it left
for this plan: the secrets **Open** in `docs/architecture.md` § Secrets management (PR 1 here
resolves it), and the account recovery **Open** in `docs/requirements.md` § Account recovery (PR 2
here resolves it).

Facts from the tree (2026-10-20) that shape the design:

- **Every production credential is in the `production` GitHub Environment**, named in
  [`deploy.yml`](../../.github/workflows/deploy.yml), which is the list; two in-flight plans change
  it (`email-provider.md` adds Postmark's token, `production-sign-in.md` removes `SITE_PASSWORD`).
  Seven vendors hold a credential of ours: GitHub, DigitalOcean, Supabase (the `postgres` password,
  the S3 key pair, and two role passwords set by hand), Grafana Cloud, Better Stack, OpenAI, and
  Postmark once it lands. Web deploys on every push to `main` and migrates first; the worker
  deploys only by `workflow_dispatch`. A re-run of an old `deploy-web` run skips itself once `main`
  has moved on. Bad deploys are reverted, never rolled back (architecture § Bad deploys are fixed
  forward).
- **No vendor console URL appears anywhere in the tree.** `apps/grafana/gcx-cloud.yaml:4` keeps
  the Grafana stack hostname out "of the repo, which is public", and `alerts.md` keeps alert
  addresses in an Environment variable for the same reason.
- **Agents are denied the hosted CLIs**: `doctl`, `gcx`, `gh secret`, `gh workflow run`, hosted
  Supabase (`.claude/settings.json`). A runbook is run by a person in a vendor's dashboard, so
  nobody has to set up a CLI to follow one.
- **House skills never run scripts, and rules are path-scoped pointers**: `db.md` points at
  `packages/db/README.md`, and `web.md` at `apps/web/README.md`.
- **`cache_client`'s one password is shared** by every developer and data scientist holding
  `CACHE_DB_CONNECTION_STRING`; `metrics_reader`'s rotation is already written on
  `apps/grafana/scripts/deploy.ts:11-14`; `ALTER ROLE` passes the write guard
  (`012_write_guard.ts:18-19`).
- **What each failure reason means is code** (`packages/db/src/analysis-failure-explanations.ts`,
  a `Record` over the enum), so no runbook lists reasons.
- **`audit_actor_kind` has a `gbd_manual` value nothing writes** (`public-schema.sql:77-82`;
  `audit.ts` writes only `'user'`). The draft's by-hand example promotes a superadmin with no
  audit row.
- **Open items this plan closes:** `docs/architecture.md` § Secrets management (no process for
  a suspected leak); `docs/requirements.md` § Account recovery ("TBD").

## Decisions

### `docs/runbooks/`, one file per runbook, with a README that is the index and the rules

Runbooks cross a vendor UI and at least two components, which the `writing-docs` skill and the
revamp both put in `docs/`. A folder rather than one file because each runbook is read alone,
under some pressure, and a file is what a person opens, links, and searches for by name. File
names say what the reader is trying to do, or what happened, in lowercase kebab.

- **The README's vendor table lists only what exists.** A plan that adds a vendor resource adds
  its row: `email-provider.md` Postmark's server and two streams, `better-stack.md` its views and
  monitor.
- **`.claude/rules/runbooks.md`** carries the two things an agent must know before it reads
  anything — it never performs a runbook, and the public-file rule — and points at the README for
  the rest, which is the `db.md` pattern.
  *Considered, not done: a bullet in the `writing-docs` skill instead.* The skill loads on the
  model's judgment; a rule loads whenever the path is touched.

### Public, with links to entry pages, never into an account

The folder may name what is already public: app and role names, Environment variable names, the
vendors. Never a credential, a connection string, a person's address, a stack hostname, project
ref, team or app id, or a deep link into a console. A link is the vendor's entry page plus the
resource's name: "cloud.digitalocean.com/apps → `foodservice-insights-web`". That is what
`gcx-cloud.yaml` already decided, and it costs one click over a deep link.
*Considered, not done: deep links to logs and dashboards.* They sit behind sign-in, so the risk
is small, but they are the one thing a public file would add for someone scanning for a Grafana
or Better Stack login page, and a browser bookmark gives the team the same click.

### Writing one

The README's § Writing one holds the conventions. What it leaves to the writer: `deploy.yml`'s
step comments already say what a failed step means; `packages/db/README.md` § Writing a migration
says a schema may run ahead of code; alert thresholds stay on the rules (`alerts.md`); hosted
settings stay on `budget.ts`. **A procedure another plan owns is written by that plan's PR**,
under the file name this plan reserves, so there is one owner per entry.

### Markdown, not scripts or skills

A person runs these; agents are denied the hosted CLIs by design, so there is nothing for a
skill to execute. Each entry is a few dashboard steps, with a shell line only where no
dashboard can do the step. The one
candidate for a script, the marked transaction in "Write to the database by hand", is better as
prose: a script would put the guard's opt-in in committed code, which the hint deliberately
avoids so that an agent stops (`012_write_guard.ts`, the comment above `require_marked_writer`).

- **Revisit when** an entry passes about ten shell steps, or someone has run one wrong twice.
  Then the form is the import's: `--production`, refuses without a TTY, prompts for the
  credential, confirms with a typed word.

### Every credential, one file, one shape

`rotate-a-secret.md` opens with the steps every rotation shares (mint, leaving the old one
working; paste it into the Environment in GitHub's settings; redeploy *both* apps, or for a secret
only CI uses, check it instead; only then delete the old value).
Each credential then gets only what differs from those steps:

- **A table row** where the shared steps fit unchanged: *secret*, *minted at*, *then* (what else
  moves, and the check for a CI-only secret). The OpenAI key, the S3 pair, the Better Stack token,
  the Grafana token, `metrics_reader` (a link to `deploy.ts`' header), the site password, and
  Postmark's token.
- **A section** where the steps themselves differ, or a decision is made here: the DigitalOcean
  token (scopes, who mints it, no expiry); the deploy tags SSH key (minted locally, multi-line,
  the old key kept until a tag moves); `cache_client` (never in the Environment; a handoff in
  place of a redeploy); and the `postgres` password only if Supabase's reset kills the old one at
  once, which breaks step 1. **Open, check while writing.**
- *Rejected: a section per credential.* Seven of them would be three lines each repeating the
  shape, and the four that differ would not stand out.
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
  login that will stay on the team creates it. **Open:** both vendor facts are still to confirm in
  DigitalOcean's UI.

### What is in, and who writes what other plans promised

| File | Why it earns its place |
| --- | --- |
| `README.md` | The index, the vendor table, the conventions |
| `deploy-the-worker.md` | The one deploy that is by hand, and when it is due |
| `write-to-the-database-by-hand.md` | Named by the guard's error hint |
| `review-cache-suggestions.md` | The three UI steps; the rules stay in `002_caches.ts`, `product-categorization.ts` and the guard |
| `rotate-a-secret.md` | Every credential, where it is minted, what else moves |
| `a-credential-leaked.md` | Closes the **Open** in `docs/architecture.md` § Secrets management |
| `offboard-a-person.md` | Crosses every vendor team and two rotations |
| `restore-the-database.md` | Two sentences the vendor's docs cannot say |
| `change-a-users-email.md` | Resolves the REQUIREMENTS TBD; why the dashboard and not SQL |
| `trace-a-problem-through-the-logs.md` | Reserved: `better-stack.md` PR 1 writes it |
| `a-user-did-not-get-an-email.md` | Reserved: `email-provider.md`'s PR writes it |

- `better-stack.md`'s entry already covers the path from a failed attempt's row to its log lines,
  so there is no separate triage file. `email-provider.md`'s PR writes its support runbook and
  adds Postmark's rows to the vendor table and to `rotate-a-secret.md`. `alerts.md` adds nothing: the README's one sentence, "an alert's own rule says what firing
  means, then the logs runbook", is the whole of "when an alert fires".
- *Left out:* generic vendor how-tos an agent or a search answers; the hosted project's settings,
  which stay on the code that depends on them; plan tiers, which `scripts/monthly_costs.py` holds;
  a per-reason triage table.

### By-hand changes are audited

`gbd_manual` exists for this. The by-hand example gains one `INSERT INTO audit_event` in the
same marked transaction, `actor_kind = 'gbd_manual'`, with the columns `audit.ts` fills, so the
example doubles as the template for any manual write. The email-change runbook says to record
one the same way. **Open, for Eric:** if that is more ceremony than the trail is worth, PR 2
instead adds a migration dropping the enum value.

## PR 1 — Secrets and people

- **`rotate-a-secret.md`** gains its table and remaining sections, per Decisions § Every
  credential, one file, one shape:
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
  - `cache_client`: compose the string in `.env.example`'s form, check it with `psql`, hand it
    over privately, and allow the holder's address if the project ever turns on network
    restrictions; each holder sets `CACHE_DB_CONNECTION_STRING` and runs `just pull-caches` once.
    Rotate with `ALTER ROLE cache_client PASSWORD` in the SQL editor, then re-hand it; until a
    holder updates, their `live` worker and the lab's step 1 refuse to start, by design.
  - The deploy tags SSH key, `DEPLOY_TAGS_SSH_KEY`: the private half of a write deploy key, which
    the `deploy tags` tag ruleset lets alone move `deploy/*`, so it decides what the worker
    deploys. Mint with `ssh-keygen -t ed25519 -N '' -C deploy-tags -f deploy-tags` in a scratch
    directory; add the `.pub` under Settings → Deploy keys with write access, beside the old key so
    a running deploy can still move its tag; paste the whole private key file, every line, as
    the secret; delete both files. No app holds it, so nothing
    redeploys: delete the old key once the next deploy's "Move the deploy/… tag" step succeeds.
    The ruleset bypasses every deploy key, so no other deploy key gets write access.
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

## PR 2 — Recovery, and the audit line

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
  change per the audit line. The account recovery **Open** in
  `docs/requirements.md` becomes a link.
- **The audit line** in `write-to-the-database-by-hand.md`, per Decisions: `actor_kind =
  'gbd_manual'`, `action` naming what was done, `actor_user_id` null, `detail` saying who; check
  the columns against `public-schema.sql` and `audit.ts`. Or, if the **Open** resolves the other
  way, a migration dropping the enum value.
- `/plan-advance` deletes this plan.

## Verification

Docs only, so the gates pass trivially. Per PR, by hand:

- **Links resolve.** `python3 scripts/ci/check_doc_links.py`, which CI also runs.
- **The guard's hint still matches.** `git grep -n 'Write to the database by hand'` shows the
  file's title, the hint in `019_write_guard_hint_links_runbook.ts`, `public-schema.sql` and
  `write-guard.test.ts`, all spelled the same, and the hint's URL still opens the file.
- **PR 1:** each vendor page named was opened while writing; any that could not be checked is
  marked **Open** in the entry. The DigitalOcean no-expiry option and token ownership are
  confirmed in its UI, and `rotate-a-secret.md`'s token section is corrected if either is wrong.
- **PR 2:** on the dev stack with `PUBLIC_AUTH_MODE=supabase`, sign in as one address, change it
  in Studio's Auth → Users, sign in with the new address: same `app_user.id`, same reports. Run
  the by-hand example as written: the `audit_event` row appears with `actor_kind = 'gbd_manual'`,
  and the same statements without `set local` are refused.
