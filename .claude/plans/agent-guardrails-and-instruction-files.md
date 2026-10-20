# Agent guardrails and instruction files

## Context

The repo is maintained almost entirely through AI agents, so far by one engineer. Teammates with
less engineering background will follow, and the recent database lockdown (#672, #675, #677) is the
first half of making that safe. This plan is the second half, in two parts:

1. **An agent cannot do anything dangerous or irreversible from a checkout, in any permission
   mode.** Auto mode is the built-in starting mode from Claude Code v2.1.283, so permission
   prompts stop being a safety net: a classifier reviews actions instead of a person. Deny rules,
   hooks and server-side guards have to carry the weight on their own.
2. **The instruction files hold only what an agent cannot derive from the code**, following
   Anthropic's current guidance: the deletion test ("would removing this cause mistakes?"), under
   200 lines per always-loaded file, skills for on-demand procedures, path-scoped rules for
   always-on conventions, and "if Claude already does it, delete it or convert it to a hook/linter".

Three audits fed this plan (danger surface, instruction files, current docs at code.claude.com).
What they established:

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
- **Instruction files:** `typescript.md` (183 lines) repeats READMEs or code comments in roughly a
  third of its lines, scopes 42% of itself to `apps/web` or `packages/db` by prose only, and
  carries about nineteen stale claims (listed under PR 5). `.claude/plans/` holds a note that says
  of itself "not planned work", which AGENTS.md § Claude Code plans says never happens.
  `.claude/commands/` is superseded by skills, and the commands' descriptions sit in context every
  turn. The hook matcher names `MultiEdit`, which no longer exists.

Decisions already taken with Eric: compress AGENTS.md § General development principles but keep
every behavioural bullet (an agent's defaults differ: mutation, `for` loops, classes,
over-generalization); leave the Bash sandbox out of this pass; forbid `bypassPermissions` mode in
this repo; `.claude/plans/runbooks.md` stays a plan (Eric will revisit it); include all three
optional PRs (guard hook, storage guard, lint-instead-of-prose).

## Decisions

- **Three layers, strongest first.** (1) Server-side: GitHub ruleset and Environment, the database
  write guard, narrow roles. (2) Code guards that hold in every permission mode and through any
  wrapper: `requirePermittedConnectionString`, the Python `cache_sync` check, and, added
  here, `requireLocalEndpoint`, which refuses the blob store's truncate on a hosted endpoint. (3) Claude Code configuration: deny/ask rules for the invocations an agent usually
  produces, and a PreToolUse hook for the forms prefix rules cannot express. Nothing in layer 3 is
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
- **Rules stay path-scoped `.claude/rules/*.md`, split by where they apply.** A bullet survives only
  if a tool does not enforce it and no README or code comment already states it; otherwise it is
  deleted or replaced by a one-line pointer to the file that owns the fact (writing-docs: one source
  of truth per fact). *Rejected: nested `CLAUDE.md` files* (same lazy loading, but the repo's
  convention is rules); *rejected: dropping `CLAUDE.md` → `@AGENTS.md` for native AGENTS.md
  support*, which only applies when no CLAUDE.md exists and not in every session type.
- **Commands become skills** (`.claude/commands/` is merged into skills in current Claude Code).
  `plan-adopt` and `plan-advance` get `disable-model-invocation: true`: only a person starts the
  plan lifecycle, and the flag keeps their descriptions out of every turn's context.
  `prune-comments` and `test-rigor` stay model-invocable because the rules tell the agent to run
  them.
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

Wire it into the Python gate: `Justfile` `test` → `uv run pytest -n auto python/insights
python/worker_child scripts`. `just check` already typechecks `scripts`; keep the script on 3.9
syntax since it runs under the system `python3`, and ty's 3.14 target does not mind. The CI
`python` filter already includes `scripts/**` (only `scripts/supabase` is excluded).

Where this stops: a command assembled from variables or `sh -c` passes. That is the documented limit
of text matching; the sandbox and the server-side guards are the boundary beyond it.

## PR 3: Commands become skills; the screenshot note finds its home; README gets a Claude Code section

**Skills.** Move each of `.claude/commands/{plan-adopt,plan-advance,prune-comments,test-rigor}.md`
to `.claude/skills/<name>/SKILL.md`, keeping `description`, `argument-hint`, `allowed-tools` and
the body. Add `disable-model-invocation: true` to plan-adopt and plan-advance. Drop `Glob` and
`Grep` from every `allowed-tools`. In prune-comments and test-rigor, diff against `origin/main`
after `git fetch origin main`, as plan-advance already does (the local `main` lags). In test-rigor,
replace the paragraph that paraphrases AGENTS.md § Testing philosophy with the reference and keep
only the three-pass procedure. In plan-adopt, "AGENTS.md § Plans" → "§ Claude Code plans". Delete
`.claude/commands/`.

**Runbooks stay where they are.** `.claude/plans/runbooks.md` carries an **Open** on where
runbooks belong, which Eric will settle separately; its links from README.md:112 and
ARCHITECTURE.md:78 are untouched.

**The screenshot note.** `.claude/plans/if-charts-return-screenshot-note.md` says of itself "not
planned work". Its two confirmed findings and the technique that works belong beside the suite they
describe: add a short paragraph to `apps/web/e2e/README.md` § Screenshots ("an `<img>` whose `src`
redirects to a signed storage URL cannot render in the browser container, because the signed Host
cannot be rewritten and `page.route()` cannot intercept the redirected leg; route the pre-redirect
app-origin URL instead"). Read the whole note before condensing it. Delete the plan.

**Stale pointers into plans:** `apps/web/src/lib/server/auth/site-password.ts:2` says it is deleted
with `email-provider.md`; the deletion is `production-sign-in.md` PR 2.
`packages/db/scripts/temporary-go-live-cache-import/README.md:5` links a "§ Go-live" heading that
`caches-to-supabase.md` does not have.

**README.** Replace the line under § Developing that tells people to set up the Svelte MCP server
by hand (`.mcp.json` already ships it) with a `### Working with Claude Code` subsection, about
fifteen lines, written for a teammate who has never configured an agent: what loads on its own
(AGENTS.md always; a stack's rule file when you touch its files; skills by name, listing the four
and when to type them); that a refusal from the database, the hook or a permission rule means
"stop and ask a person", never "find another way"; that `.claude/settings.local.json` is personal
and gitignored; and that `/doctor prompt-audit` (Claude Code ≥ 2.1.283) reports stale instructions
after a rules change. Load the `writing-docs` skill before writing it.

## PR 4: Lint instead of prose

Each item turns a rule bullet into an enforced check, so PR 5 can delete the bullet.

- **Biome:** enable `useConsistentFunctionStyle` (nursery, present in the installed 2.5.15; read
  its options in `node_modules/@biomejs/biome/configuration_schema.json`) as an error, configured
  for declarations at module scope. Fix the six test files that use `const name = () =>` at module
  scope: `apps/web/src/hooks.server.test.ts`, `apps/web/src/lib/server/storage.test.ts`,
  `apps/web/src/lib/reports/csv/read/parse.test.ts`, `…/csv/rules/dates.test.ts`,
  `…/csv/rules/date-order.test.ts`, `packages/email/src/messages/layout.test.ts`. If the rule
  cannot express "declarations at module scope, arrows as callbacks", leave Biome alone and keep
  the bullet in PR 5.
- **Ruff:** add `"PTH"` to `select` in the root `pyproject.toml` and fix the three remaining
  `os.path` uses.

## PR 5: Rules and AGENTS.md hold only what the code cannot say

Every bullet removed below is either enforced by a tool, stated in a README or code comment, or
stale; the table says where each fact lives afterwards. Where a fact had no home outside the rule,
it moves into a comment on the file that enacts it, per the writing-docs skill. Load that skill
first.

**AGENTS.md** (keep every section):

- § General development principles: compress to the version Eric approved, which keeps every
  behavioural bullet and cuts only the hedging and generic sentences ("not rigid", "code is written
  for humans", "not always the best choice", "don't be dogmatic"). The `### Functional style`
  subheading goes; its bullets fold into the one list. Approved text:

  > Context beats dogma: sometimes DRY is right, sometimes WET. Beyond that, the defaults we want
  > differ from an agent's defaults:
  >
  > - **Solve it the simplest way.** Future needs are hard to predict; simple code is the easiest
  >   to refactor, so no premature generalization.
  > - **Keep the abstraction level a reader can hold**, about seven things at once: helper
  >   functions, whitespace, data structures.
  > - **Immutable by default**, and `map`/`filter`/`reduce` over an unconstrained `for` loop when
  >   they read better.
  > - **Make illegal states unrepresentable**: algebraic data types and `color: 'red' | 'green'`,
  >   not `color: string`.
  > - **Composition over inheritance; classes are often overkill**, and keep class-level state
  >   minimal.
  > - **Early returns**, so the main logic is not nested. **Extract pure functions** from impure
  >   ones; they are what tests reach easily.

- Routing table: TypeScript is `apps/`, `packages/`, `tests/`; the rule globs are the truth.
- § Off limits: add `.claude/settings.json` and `scripts/claude/` ("the guardrails; change them
  only when that is the task").
- § Verifying a change is unchanged; the `--repeat-each` line stays (it prevents a real collision
  and is one line).

**`.claude/rules/typescript.md`** → three files plus a contract rule. Target under 70 lines for
`typescript.md`, under 30 for `web.md`, under 12 for `db.md`, under 8 for `contract.md`.

`typescript.md` (`paths`: `apps/**`, `packages/**`, `tests/**`, the root configs; drop
`contract/**`):

| Keep | Replace or drop | Where the fact lives now |
| --- | --- | --- |
| Gate; iteration loop with the vitest `--filter` form; Playwright through Turbo and why; `test:system` not in the gate; background gate and no concurrent Turbo | The script inventory and `--filter` fallback paragraph | derivable from `package.json` files; README § Everyday commands |
| Test organization, compressed to three lines | — | — |
| `async`/`await`; cross-package imports by name; `dist/` + `^build` (reworded: tasks that need a build declare it, not "every other task"); logging via `@gbd/core/log` with `err` and ids | Module-scope `function` declarations | Biome, PR 4 (keep if PR 4 skipped it) |
| | Test-file suffixes | README's table; the rule keeps one pointer line |
| Cross-cutting database bullets: `db: DatabaseExecutor` first; `withRollback` and the concurrency exception (point at `concurrency.ts`, which already explains it); classify failures with `isTransientDatabaseError`/`isPermanentDatabaseError` in app code (fix: `packages/db` itself matches codes); fixture naming (point at `fixtures/index.ts` header; drop "in its table's file", which is false) | `TEST_DB=1`, `scripts/supabase`, snake_case, "to read the schema", `database()` placement, the importer list | README § The two databases; the deny rule; `db.md`; `packages/db/README.md` |
| Blob store: one line, `isBlobStoreError` and `packages/storage/README.md` | the second sentence | that README |
| `catalog:` one line; quote parentheses | the exact-pin reasoning | a comment on the `vitest:` and `playwright:` lines of `pnpm-workspace.yaml` |
| | "`lint` and `fmt` exist only at the root" and the per-package script list | derivable |
| | The documentation rules "in AGENTS.md" | they are in the writing-docs skill; say so in the intro |

`web.md` (`paths`: `apps/web/**`), new:

| Keep | Drop | Where it lives now |
| --- | --- | --- |
| One line: Svelte in training data is Svelte 4, check the MCP server; `svelte-core-bestpractices` loads for `.svelte` files; hand self-contained component work to `svelte-file-editor` | "Svelte 5 runes only" | `runes: true` in `vite.config.ts` plus `svelte-check --fail-on-warnings` |
| `svelte-kit sync` is inlined on purpose | `render` is async | the type signature |
| `_`-prefixed route functions taking `db`, called from the handler; no `+` in test file names | Runtime config "dynamic, never static" | `src/env.ts` header and ARCHITECTURE § Secrets management; keep a pointer |
| `withDbErrorHandling` / `withBlobStoreErrorHandling`: one line each pointing at the doc comments in `lib/server/db.ts` and `storage.ts` (fix: a blob store failure is "did not reach the store or came back refused") | the four paragraphs of mechanism | those doc comments |
| `dependency` not `devDependency`, one line | the reasoning | `vite.config.ts:11-27` |

`db.md` (`paths`: `packages/db/**`), new: migration columns in snake_case and why; read
`public-schema.sql` and `src/generated/`, not the migrations; `packages/db/README.md`
§ Conventions and § Writing a migration are the rules for this package.

`contract.md` (`paths`: `contract/**`, `apps/worker/src/contract/**`,
`python/worker_child/**`), new: `contract.json` and the fixtures change together, both stacks parse
them, run both gates; the procedure is in `contract/README.md`. Remove `contract/**` from the two
big rules so a contract edit loads 8 lines instead of 263.

**`.claude/rules/python.md`** (same `paths` minus `contract/**`; target under 40 lines):

| Keep | Drop | Where it lives now |
| --- | --- | --- |
| Gate, with `TEST_DB=1 just test-lab` for the lab (the bare form skips its database tests) | one venv; deps in the importing package; tests in `<package>/tests/` | `python/README.md`, root `pyproject.toml` comment |
| No `[tool.ruff]` in a package `pyproject.toml`, one line | its explanation | a comment on `[tool.ruff]` in the root `pyproject.toml`, which is the file that enacts it |
| Packaged assets via `PACKAGE_DIR`, one line | the *Rejected: importlib.resources* line | a comment in `gbd_foodservice_insights/__init__.py` next to `PACKAGE_DIR` |
| Lab boundary: direction, where code goes, "check the product needs it", "no caller ≠ dead" | "Ruff enforces this; the root pyproject holds the reasoning" | make it true: put the one-paragraph reasoning on the `banned-api` block |
| `LlmClient` seam; `KeywordLlmClient` in tests | Gemini ban | Ruff `banned-api` |
| ty, annotate new code | "the ported library largely is not annotated" and `[[tool.ty.overrides]]` | false: 99% annotated, no overrides exist |
| Fail loudly; row counts; nothing per row | `pathlib` over `os.path` | Ruff `PTH`, PR 4 |

**Also in this PR:** fix the `.github/filters.yml` comment only if a path it names moved (none
should); run `scripts/ci/check_filters.py` anyway.

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
- **PR 3:** the four skills appear in the `/` menu; `/plan-adopt` and `/plan-advance` do not appear
  in the skill list Claude sees (check `/context`); `/prune-comments` runs. The condensed
  screenshot paragraph names files that exist (`grep` each path it mentions), and
  `grep -rn "if-charts-return"` across the repo is empty.
- **PR 4:** `pnpm lint` and `just lint` pass, each after fixing exactly the listed violations.
- **PR 5:** line counts within target; `/context` after reading a file under `apps/web` shows
  `typescript.md` and `web.md` loaded and not `db.md`; after reading `contract/contract.json` only
  `contract.md`. With Claude Code ≥ 2.1.283, `/doctor prompt-audit` reports no stale or conflicting
  instructions. Every pointer written into a rule resolves (`grep` each path).
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
5. **Update Claude Code to ≥ 2.1.283** before PR 5, for `/doctor prompt-audit`.
