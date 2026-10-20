# Agent guardrails

## Context

The repo is maintained almost entirely through AI agents, so far by one engineer. Teammates with
less engineering background will follow, and the recent database lockdown (#672, #675, #677) is the
first half of making that safe. This plan is the second half: **an agent cannot do anything
dangerous or irreversible from a checkout, in any permission mode.** Auto mode is the built-in
starting mode from Claude Code v2.1.283, so permission prompts stop being a safety net: a
classifier reviews actions instead of a person. Deny rules, hooks and server-side guards have to
carry the weight on their own.

Two audits fed this plan (the danger surface, and the current docs at code.claude.com). What they
established:

- **The production boundary is already server-side and cannot be reached from a laptop.** The main
  ruleset requires a PR, the `CI` check and the merge queue, with no bypass actors. Production
  secrets exist only in the `production` GitHub Environment, which deploys from `main` only. The
  database refuses writes and DDL from unmarked `postgres` sessions; `cache_client` can only
  SELECT and insert suggestion rows. A checkout holds at most `CACHE_DB_CONNECTION_STRING` as
  `cache_client`, and both stacks refuse other hosted connections.
- **What a laptop can still do:** merge a PR (`gh pr merge`), which deploys web and runs
  migrations in production; dispatch the worker deploy (`gh workflow run`); administer the repo and
  the user's hosted accounts (`gh api -X`, `gh secret`, `doctl` and `gcx` are both installed and
  configured on this machine); spend OpenAI/Gemini money; destroy local state (`pnpm truncate`,
  `test:db:clean` across worktrees, `scripts/supabase stop --no-backup`, `just pull-caches`
  overwriting the privately supplied CSVs, `git rm -f`); read `.env` through a sibling worktree,
  `grep -r`, `xargs cat` or any interpreter. And `Bash(pnpm:*)`, `Bash(uv:*)`, `Bash(just:*)`
  each allow an arbitrary command without a prompt (`pnpm exec …`, `uv run bash -c …`,
  `just -c …`), which routes around every deny and ask rule, because Claude Code does not unwrap
  runners when matching rules.
- **The docs are explicit that Bash permission rules "aren't a security boundary around the
  program"** (they match the invocation Claude usually produces, not `sh -c`, `/usr/bin/x`, or a
  variable). The OS-level boundary is the Bash sandbox, which also makes `.claude/`, `.mcp.json`
  and `.git/hooks` unwritable from shell commands. Writes to `.claude/` through the file tools are
  already never auto-approved except in `bypassPermissions` mode.
- **The `PostToolUse` hook matcher names `MultiEdit`**, which no longer exists.

Decisions already taken with Eric: leave the Bash sandbox out of this pass, forbid
`bypassPermissions` mode in this repo, and include the guard hook.

## Decisions

- **Three layers, strongest first.** (1) Server-side: GitHub ruleset and Environment, the database
  write guard, narrow roles. (2) Code guards that hold in every permission mode and through any
  wrapper: `requirePermittedConnectionString`, the Python `cache_sync` check, and
  `requireLocalEndpoint`, which refuses the blob store's truncate on a hosted endpoint. (3) Claude
  Code configuration: deny/ask rules for the invocations an agent usually produces, and a PreToolUse hook for the forms prefix rules cannot express. Nothing in layer 3 is
  relied on as a boundary; it exists so that the common case stops early with a message that says
  "ask a person".
- **Deny vs ask.** *Deny* anything that reaches a hosted or paid resource or administers an
  account: a person does those from their own shell, never through an agent. *Ask* anything
  irreversible locally or outward-facing (push, PR creation, CI and deploy config edits).
  Content-scoped ask rules such as `Bash(git push *)` still prompt in auto mode and in the
  sandbox's auto-allow mode, which is why they are written out even where the command would prompt
  today merely for lack of an allow rule.
- **The guard hook lives in `scripts/claude/`, not `.claude/hooks/`.** `just lint`, `just check`
  (`ty check python scripts`) and the CI `python` job cover `scripts/**`; `.github/filters.yml`
  excludes `.claude/hooks/**` from every job. It fails closed: if the interpreter is missing or the
  script crashes, the command is blocked with the error, not allowed.
- *Rejected for now: the Bash sandbox.* It is the only OS-level boundary the docs offer, but in
  this repo the verification gate, the Supabase CLI, Docker, `pnpm dev`, `gh` (Go TLS under
  Seatbelt) and git over the SSH remote would all have to be excluded, so the gate runs with full
  access anyway; `pnpm install` and `uv sync` write to caches under `~` and would fail sandboxed
  and silently rerun unsandboxed through the `pnpm:*`/`uv:*` allow rules; and on Linux a sandboxed
  command cannot reach the local databases at all. The exclusion list would rot untested. Revisit
  when a second developer's workflow can validate it; the policy can then be committed without
  `enabled` (settings lists merge across scopes) and each developer opts in with `/sandbox`.
- **Keep auto mode available.** Its classifier blocks production deploys, force pushes, secret
  exfiltration and discarding uncommitted work on top of the rules here. Only bypass mode is
  removed (`permissions.disableBypassPermissionsMode`).
- **No CI or deploy workflow changes** (off limits). The GitHub-side controls that would help a
  larger team are listed at the end as manual steps for Eric.
- *Rejected: hardening `scripts/supabase` to refuse hosted flags.* The hook sees the bare CLI and
  `pnpm exec supabase` as well as the wrapper; a wrapper-only check covers one of three forms.
- *Rejected: a `Stop` hook that runs the verification gate.* AGENTS.md's instruction plus CI
  already gate merges; the hook would cost minutes per turn.

## PR 1: Permission rules and sandbox policy

Only `.claude/settings.json` and one comment in `.env.example`. No code.

**`permissions.deny`, add** (keep every existing entry):

- Hosted-account CLIs on a developer machine: `Bash(doctl:*)`, `Bash(gcx:*)`.
- GitHub actions that deploy or administer: `Bash(gh pr merge:*)`, `Bash(gh workflow run:*)`,
  `Bash(gh workflow enable:*)`, `Bash(gh workflow disable:*)`, `Bash(gh release:*)`,
  `Bash(gh ruleset:*)`, `Bash(gh repo edit:*)`, `Bash(gh repo archive:*)`,
  `Bash(gh repo rename:*)`, `Bash(gh repo transfer:*)`, `Bash(gh repo sync:*)`,
  `Bash(gh auth login:*)`, `Bash(gh auth refresh:*)`, `Bash(gh auth setup-git:*)`,
  `Bash(gh auth switch:*)`. Mutating `gh api` forms, both flag-first and flag-later:
  `Bash(gh api -X:*)`, `Bash(gh api --method:*)`, `Bash(gh api -f:*)`, `Bash(gh api -F:*)`,
  `Bash(gh api --field:*)`, `Bash(gh api --raw-field:*)`, `Bash(gh api --input:*)`, and the same
  seven as `Bash(gh api * -X *)` etc. (`-f`/`-F`/`--input` imply POST). Plain `gh api <path>` stays
  allowed by nothing and prompts, which the investigating-flakes skill relies on.
- Runner escape hatches: `Bash(pnpm exec:*)`, `Bash(pnpm --filter * exec *)`,
  `Bash(pnpm -F * exec *)`, `Bash(pnpm -r exec *)`, `Bash(pnpx:*)`, `Bash(uv run bash:*)`,
  `Bash(uv run sh:*)`, `Bash(uv run zsh:*)`, `Bash(just -c:*)`, `Bash(just --command:*)`,
  `Bash(just --shell:*)`.
- Supabase CLI beyond the local stacks: `Bash(scripts/supabase -*)` (a global flag before the
  subcommand dodges every subcommand rule, and `--help` is not worth the hole),
  `Bash(scripts/supabase * --db-url *)`, `Bash(scripts/supabase * --linked*)`,
  `Bash(scripts/supabase * --project-ref *)`, and the hosted-only subcommands:
  `backups`, `storage`, `config push`, `functions`, `network-bans`, `network-restrictions`,
  `ssl-enforcement`, `sso`, `domains`, `vanity-subdomains`, `encryption`, `orgs`, `snippets`,
  `postgres-config`, `logout`, `unlink`, `db pull`, each as `Bash(scripts/supabase <sub>:*)`.

**`permissions.ask`, add:**

- `Bash(git push:*)`, `Bash(gh pr create:*)`, `Bash(gh pr close:*)`, `Bash(gh pr ready:*)`,
  `Bash(gh pr review:*)`, `Bash(gh pr comment:*)`, `Bash(gh issue create:*)`,
  `Bash(gh issue comment:*)` (the repo is public; comments are outward-facing).
- Discarding work: `Bash(git reset --hard:*)`, `Bash(git checkout -- *)`, `Bash(git checkout .)`,
  `Bash(git restore:*)`, `Bash(git clean:*)`, `Bash(git stash drop:*)`, `Bash(git stash clear:*)`,
  `Bash(git branch -D:*)`.
- Local data: replace the three truncate entries with `Bash(pnpm *truncate*)` (a `*` spans
  spaces, so this also catches `--filter` and `run` forms and trailing flags), and add
  `Bash(pnpm *db:clean*)` (force-drops every `fsi_test_*` database, including other worktrees'
  live runs), `Bash(pnpm *temporary-go-live-cache-import*)`,
  `Bash(scripts/supabase stop --no-backup*)`, `Bash(scripts/supabase * --no-backup*)`,
  `Bash(just pull-caches:*)` (overwrites the gitignored CSVs GBD hands out privately).
- CI and deploy configuration, which AGENTS.md puts off limits unless asked:
  `Edit(.github/**)`, `Write(.github/**)`, `Edit(.do/**)`, `Write(.do/**)`.

**`permissions.allow`, change:** remove `Bash(git rm *)` (`git rm -f` deletes uncommitted work;
`git rm` is rare enough to prompt), and remove `Glob` and `Grep` (those tools are absent by default
on macOS and Linux, so the entries are dead). Leave `Bash(pnpm:*)`, `Bash(uv:*)`, `Bash(just:*)`:
with the exec/shell forms denied they cover the everyday commands, and auto mode drops
package-manager allow rules on its own and routes those commands to the classifier.

**Other keys:** `"permissions": { "disableBypassPermissionsMode": "disable" }`. Hook matcher
`Edit|Write|MultiEdit` → `Edit|Write`. Check rule syntax against
<https://code.claude.com/docs/en/permissions> while implementing: `Bash(x:*)` and `Bash(x *)` are
the same prefix form, a `*` matches across spaces, and a trailing `*` without a space also matches
`xyz`.

**`.env.example` lines 7–8** still say the apps "can't tell a hosted database from a local one, so
this comment is the only guard". Replace with one line pointing at
`packages/db/src/connection-string.ts` for what is refused and why.

## PR 2: A tested PreToolUse guard for what prefix rules cannot say

`scripts/claude/bash_guard.py`, stdlib only, run as `python3 -I` so it works before `just sync`.
It reads the hook JSON on stdin, exits 0 unless `tool_name` is `Bash`, and scans
`tool_input.command` as one string, so `pnpm exec doctl …`, `VAR=1 doctl …` and `/usr/bin/doctl`
all match. On a match it prints one line to stderr naming the rule and what a person should do, and
exits 2. Each pattern carries its reason:

| Refuses | Pattern sketch | Reason the agent sees |
| --- | --- | --- |
| `doctl`, `gcx` anywhere | `\b(doctl\|gcx)\b` | hosted DigitalOcean / Grafana Cloud credentials; a person runs these |
| `gh pr merge`, `gh workflow run\|enable\|disable`, `gh release`, `gh ruleset`, `gh secret`, `gh variable`, `gh repo edit\|delete\|archive\|rename\|transfer\|sync`, `gh auth login\|logout\|refresh\|setup-git\|switch\|token`, `gh pr review … -a\|--approve`, `gh api` with `-X`/`--method` other than GET or with `-f`/`-F`/`--field`/`--raw-field`/`--input` | word-boundary regexes | merging deploys production; the rest administers the repository |
| `supabase` with `--db-url`, `--linked`, `--project-ref`, `--password`/`-p`, or a hosted-only subcommand (the PR 1 list plus `login`, `link`, `projects`, `secrets`, `branches`, `db push`) | `\bsupabase\b` + flags/subcommand | the CLI here is for the local stacks; `scripts/supabase` points at them |
| a non-local Postgres URL, a Supabase database host, the DigitalOcean API | `postgres(ql)?://[^\s'"]*@(?!(localhost\|127\.0\.0\.1\|host\.docker\.internal)[:/])`, `\.(supabase\.co\|pooler\.supabase\.com)\b`, `api\.digitalocean\.com` | hosted database or API in a command |
| any path to a `.env` file other than `.env.example` / `.env.test` | `(^\|[\s"'=:/])\.env(?!\.(example\|test)\b)\b` | `.env` holds secrets; the apps read it themselves |

The `.env` rule closes the sibling-worktree hole (`cat ../foodservice-insights/.env`), `xargs cat`,
`grep` and `uv run --env-file .env`. It also blocks `cp .env.example .env`; the message says that
first-time step is the developer's.

Register it in `.claude/settings.json`:

```json
"PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "timeout": 10,
  "command": "python3 -I \"$CLAUDE_PROJECT_DIR/scripts/claude/bash_guard.py\" || exit 2" }] }]
```

`|| exit 2` is the fail-closed part: a missing `python3` or a crash blocks the command and shows
the error, rather than letting it through as a non-blocking hook failure. Hooks from project
settings also run inside subagents, so the svelte-file-editor is covered.

**Tests:** `scripts/claude/tests/test_bash_guard.py`, black-box: run the script with
`subprocess.run([sys.executable, "-I", path], input=json.dumps(hook_input))` and assert exit code
and stderr. Parametrize roughly twenty refused commands (one per pattern form, including the
wrapped forms: `pnpm exec gh pr merge 12`, `TEST_DB=1 scripts/supabase db query --db-url …`,
`cat ../foodservice-insights/.env`, `gh api -X DELETE repos/x/y`, `gh api repos/x/y -f name=z`) and
roughly fifteen allowed ones that sit right next to them: `gh pr view 12`, `gh pr list`,
`gh api repos/x/y/actions/runs/1/artifacts`, `gh api --method GET repos/x/y`,
`scripts/supabase start`, `TEST_DB=1 scripts/supabase status`, `pnpm migrate`,
`cat .env.example`, `cp .env.example .env.test`, a local `postgresql://…@127.0.0.1:55322/…`,
`curl https://supabase.com/docs`, `git push origin HEAD`, and a non-Bash `tool_name`. Also assert
the exit-0 path writes nothing to stdout. Each case is one interpreter start, about 50 ms, so the
file adds about 2 s serial and well under a second under `-n auto`, locally and in CI.

Extend AGENTS.md § Off limits, whose guardrails line names only `.claude/settings.json` so far, to
name `scripts/claude/` too.

Wire it into the Python gate: `Justfile` `test` → `uv run pytest -n auto python/insights
python/worker_child scripts`. `just check` already typechecks `scripts`; keep the script on 3.9
syntax since it runs under the system `python3`, and ty's 3.14 target does not mind. The CI
`python` filter already includes `scripts/**` (only `scripts/supabase` is excluded).

Where this stops: a command assembled from variables or `sh -c` passes. That is the documented limit
of text matching; the sandbox and the server-side guards are the boundary beyond it.

## Verification

- **PR 1:** in a session in this repo, `/permissions` lists the new rules. Ask Claude to run
  `gh pr merge --help`, `pnpm exec echo hi`, `scripts/supabase --help`: all denied. Ask it to run
  `pnpm truncate --filter=@gbd/db`, `git push origin HEAD`, `pnpm test:db:clean`: all prompt. Edit
  a file under `.github/`: prompts. `claude --dangerously-skip-permissions` refuses to start in this
  directory. Then the everyday commands still run unprompted: `pnpm lint && pnpm check`,
  `pnpm migrate`, `pnpm --filter @gbd/core test:unit`, `just lint && just check && just test`,
  `scripts/supabase status`, `gh pr view`.
- **PR 2:** `just lint && just check && just test` (the new tests run). In a session, ask Claude to
  run `doctl account get` and `gh pr view`: the first is blocked with the hook's reason, the second
  runs. Temporarily rename `python3` off `PATH` in a scratch shell to confirm the `|| exit 2` path
  blocks with the "command not found" message.
- A PR that touches only `.claude/**` and Markdown runs no CI job beyond `changes`; that is the
  filters working, not a failure.

## Manual steps for Eric, outside the repo

Not PRs, and not required by the PRs above. Listed because they are the controls that matter most
once there is a second developer:

1. **`production` Environment → Required reviewers (1).** A person approves each production
   deploy. Today web deploys and migrates on every merge with no human step; this is the single
   strongest guard against an agent-merged PR. Cost: one click per merge.
2. **Main ruleset → 1 required approving review and "require approval of the most recent push"**
   as soon as there are two maintainers (an author cannot approve their own PR, so it would block a
   solo developer today).
3. **A tag ruleset for `deploy/*`** with GitHub Actions as the only bypass actor; the worker deploy
   reads its commit from `deploy/web`, which anyone with push can currently move.
4. **Local `doctl` and `gcx` tokens:** scope them to read, or remove them when not deploying by
   hand. Both are configured on this machine; PR 1 and PR 2 stop the usual invocation only.
