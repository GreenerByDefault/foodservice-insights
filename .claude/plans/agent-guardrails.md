# Agent guardrails

## Context

The repo is maintained almost entirely through AI agents, so far by one engineer. GBD staff with
less engineering background will follow. The database lockdown (#672, #675, #677) was the first
half of making that safe. This plan is the second half: **an agent cannot do anything irreversible
or account-level from a checkout, in any permission mode, even when the person driving it cannot
judge a permission prompt.** Auto mode is the built-in starting mode from Claude Code v2.1.283, so
in most sessions a classifier reviews each action, not a person.

Verified 2026-10-20 against GitHub and code.claude.com:

- **In place:** the main ruleset requires a PR, the `CI` check and the merge queue, with no bypass
  actors and no required approvals. Production secrets live only in the `production` Environment,
  which deploys from `main`, and there are no repo secrets. Push protection is on for provider
  patterns. The database refuses writes from unmarked sessions, and a checkout can hold only
  `cache_client`. `requirePermittedConnectionString` and `requireLocalEndpoint` refuse the rest in
  code.
- **Still possible from a checkout:**
  - Merging a PR, which deploys web and migrates production. Dispatching the worker deploy.
  - Changing the repo's rules, environments and secrets with an admin's token. GBD staff are
    admins and stay admins.
  - Moving or deleting `deploy/web`. When the worker deploy runs, it ships whatever commit that tag
    names. No ruleset covers tags.
  - Destroying local data: `pnpm truncate`, `test:db:clean`, `--no-backup`, `just pull-caches`.
  - Committing client data to what is a public repo.
- **Claude Code's limits:** the docs say Bash rules "aren't a security boundary": they don't look
  inside `pnpm exec` or `bash -c`. Deny rules hold in every mode, and ask rules still prompt in auto
  mode. By default, auto mode's classifier blocks production deploys and migrations, merging
  unapproved PRs, force pushes, `git reset --hard`, `git clean -fd`, `git stash drop` and sending
  secrets out. It allows pushing to any branch and opening PRs. In auto mode, edits to `.claude/`,
  including these settings, also go to the classifier rather than to a prompt. A hook that crashes
  does not block.

An earlier version of this plan proposed about ninety rules and a regex PreToolUse hook. To test
it, we replayed the 18,077 Bash commands from the 492 agent sessions in this repo between
2026-09-22 and 2026-10-20 against those rules. The rejections below give the numbers.

## Decisions

- **Each control goes where it holds no matter who runs what.** In order of strength: GitHub
  rulesets, then the credentials on the machine, then `.claude/settings.json`. An agent cannot
  rephrase its way past a refusal from GitHub, but it can get past a permission rule. The settings
  exist so that the obvious way of running something catastrophic fails at once.
- **A rule earns its place only if it almost never fires on work someone asked for.** This is the
  long-term cost to watch:
  - A prompt that gets approved by reflex forty times a week will be approved by reflex the one
    time it matters, and a teammate who can't judge a prompt approves them all.
  - A refusal that is usually wrong teaches agents to rephrase the command. That is the opposite
    of README's "a refusal means stop and ask a person".
  - A deny on a command nobody runs costs nothing.
- **What gets which rule:**
  - *Deny* whatever merges, deploys or administers and has no routine agent use.
  - *Ask* for the few named commands that destroy local data, where a person can tell from the
    command what will be lost.
  - *No rule* for everything else. Default mode prompts for anything not allowed. Auto mode's
    classifier can judge context that a static rule can't, such as whether there is uncommitted
    work.
- **Merging stays a person's job, but only the client side enforces it.** GitHub can't tell an
  agent's merge from a person's, because both use the person's token. Short of required review,
  the only checks are the `gh pr merge` denies and auto mode's classifier, which blocks merging unapproved
  PRs. Together they cover `gh pr merge` and its API spellings.
- **Keep auto mode, and remove bypass mode** (`permissions.disableBypassPermissionsMode`).
- **The only deploy workflow change is PR 1,** which the tag ruleset needs. Otherwise CI and deploy
  configuration stay off limits.
- *Rejected: required review on PRs.* One engineer writes almost every PR, so a second reviewer
  would mean friction on nearly every merge.
- *Rejected: a separate `gh` token for agent sessions that cannot merge.* The person's own token
  stays on the machine. So it stops only what the denies already stop, and every person would have
  to create and rotate a token.
- *Rejected: required reviewers on the `production` Environment.* 337 PRs merged in those four
  weeks, so this would mean about twelve approval clicks a day.
- *Rejected: a regex PreToolUse hook that scans each command.* It would have blocked 320 of the
  replayed commands (1.8%).
  - Most matched a pattern inside text: searches, heredocs, commit and PR bodies, and tests of the
    code guards that use a fake `supabase.co` URL.
  - Most of the rest were reads, such as `gcx --version`, the documented
    `gcx --config apps/grafana/gcx.yaml resources validate`, and `gh api markdown`.
  - The wrapped forms it was meant to catch never occurred, and a deliberately disguised command
    gets past text matching anyway.
- *Rejected: denying the runner escape hatches (`pnpm exec`, `pnpx`, `uv run bash`, `just -c`).*
  It would have blocked 329 replayed commands, 166 of them `biome` and 102 `vitest`. It also
  doesn't close the hole: under `Bash(pnpm:*)`, `pnpm <any binary>` falls back to `exec`.
- *Rejected: ask rules on `git push`, `gh pr create`/`comment`/`review` and
  `gh issue create`/`comment`.* They would have prompted on 159 replayed commands, nearly all of
  them requested by the user. Push protection catches secrets, and review catches content.
- *Rejected: ask rules on git discards (`reset --hard`, `checkout --`, `restore`, `clean`,
  `stash drop`, `branch -D`).* They would have prompted 59 times. Default mode already prompts for
  these, and auto mode's classifier blocks the ones that would lose uncommitted work.
- *Rejected: ask rules on edits to `.github/**` and `.do/**`.* They would have prompted on 46
  edits in 13 sessions, each one in a session where CI work was the task. A workflow on a branch
  cannot reach production secrets, so any damage needs a merge.
- *Rejected: denying every mutating `gh api` call.* The replayed ones were all POSTs:
  `gh api markdown`, `-X GET search/code -f q=` and two `force-cancel`s. The denies cover only the verbs
  and endpoints that merge, dispatch or administer, and none of those matched a replayed command.
- *Rejected: denying `doctl`, `gcx` and the hosted Supabase subcommands.* `gcx` has a local
  workflow in `apps/grafana`. The replayed `doctl` calls were reads. A `--db-url` deny would block
  the local `db dump` that agents run. Only Eric's machine has any of these CLIs logged in.
- *Rejected for now: the Bash sandbox.* It is the only OS-level boundary, but here it would have
  to exclude:
  - the verification gate, the Supabase CLI, Docker, `pnpm dev`, `gh` and git over SSH;
  - `pnpm install` and `uv sync`, which write to caches under `~`;
  - on Linux, everything that reaches the local databases.

  An exclusion list that long would rot untested. Revisit it when a second developer's workflow
  can test it.
- *Rejected: a `Stop` hook that runs the verification gate.* AGENTS.md and CI already gate
  merges, and the hook would add minutes to every turn.

## PR 1: Only the deploy workflow moves the deploy tags

**What the tags are.** After each successful deploy, the deploy workflow moves a git tag:
`deploy/web` to the commit production's web app runs, and `deploy/worker` to the worker's. When
someone dispatches the worker deploy, it deploys exactly the commit that `deploy/web` names.

**The risk.** The main ruleset protects branches, not tags. Anyone who can push can move or delete
these tags with one `git push`, and so can an agent on their machine. If `deploy/web` moves, the
next worker deploy ships a commit the web isn't running. That might be older code, or code that
needs migrations the database doesn't have yet. Nothing looks wrong until the worker misbehaves in
production.

**The fix.** Add a tag ruleset so that only the deploy workflow can create, move or delete
`deploy/*` tags.

**The catch, and why this needs a PR.** Today the workflow moves the tags with its built-in token.
GitHub doesn't let that token bypass a ruleset, but it does let a deploy key bypass one. So the
workflow has to push the tags with a deploy key instead:

- In `.github/workflows/deploy.yml`, change the two "Move the … tag" steps to push over SSH with
  the key in the `production` Environment secret `DEPLOY_TAGS_SSH_KEY`.
- Drop both deploy jobs' `contents: write` to `read`, since moving the tags was its only use. This
  also means production's deploy jobs can no longer write to the repo through their own token.
- **Open:** confirm that GitHub-hosted runners already trust github.com's SSH host key.
- A push from a deploy key triggers workflows, unlike a push from the built-in token. No workflow
  runs on tag pushes, so nothing new runs.
- The deploy key can push branches too. The main ruleset has no bypass for it, so it can't touch
  `main`, and only jobs deploying from `main` can read it.

**Eric's steps, in this order** (the web deploy fails at its tag step if PR 1 lands before step 1):

1. **Check whether the key is needed at all.** Go to Settings → Rules → Rulesets → New ruleset →
   New tag ruleset → Add bypass.
   - If the list offers *GitHub Actions*, use that in step 4, and skip the key and PR 1.
   - If it offers neither *GitHub Actions* nor *Deploy keys*, stop here: PR 1 would need a GitHub
     App instead.
2. **Make the key.** In a scratch directory, run
   `ssh-keygen -t ed25519 -N '' -C deploy-tags -f deploy-tags`.
   - Under Settings → Deploy keys → Add deploy key, title it `deploy tags`, paste in
     `deploy-tags.pub` and tick *Allow write access*.
   - Under Settings → Environments → `production` → Add environment secret, name it
     `DEPLOY_TAGS_SSH_KEY` and paste in the contents of `deploy-tags`.
   - Delete both files.
3. **Merge PR 1.** In the deploy that the merge triggers, check that the "Move the deploy/web tag"
   step succeeded.
4. **Create the ruleset.** Settings → Rules → Rulesets → New ruleset → New tag ruleset:
   - Name `deploy tags`, with Enforcement status *Active*.
   - Under Bypass list → Add bypass, choose *Deploy keys* with *Always allow*.
   - Under Target tags → Add target → Include by pattern, enter `deploy/*`.
   - Tick *Restrict creations*, *Restrict updates*, *Restrict deletions* and *Block force pushes*,
     then Create.
5. **Check that it holds.** Run
   `git tag deploy/ruleset-check && git push origin deploy/ruleset-check`. GitHub should refuse
   it. Then run `git tag -d deploy/ruleset-check`. The next worker deploy you dispatch should move
   `deploy/worker`.

## Verification

**PR 1:** Eric's steps 3 and 5 above.

## Manual step for Eric: catch connection strings in commits

Push protection already refuses provider secrets such as OpenAI keys. It doesn't look for
"generic" patterns, which include Postgres connection strings. Here the likeliest secret to end up
in a commit is a `CACHE_DB_CONNECTION_STRING`.

1. On the repo, go to Settings, then *Advanced Security* in the sidebar's "Security and quality"
   section. Under *Secret Protection*, click *Enable* next to *Generic patterns*.
2. If a push protection option for generic patterns appears, turn that on too. Without it, a
   connection string in a pushed commit raises an alert instead of being refused. On a public repo,
   an alert means you rotate the password with `ALTER ROLE`.
3. If there's no *Enable* button, this repo's plan doesn't include the feature, and you can drop
   this step.
4. To check, run
   `gh api repos/GreenerByDefault/foodservice-insights --jq .security_and_analysis.secret_scanning_non_provider_patterns.status`.
   It should print `enabled`.

## Not covered

- **Open: prompt injection.** On a public repo, issues, PR comments and fetched pages are untrusted
  input. Only the classifier checks a command that an injected instruction has disguised. The
  sandbox's network allowlist is the real boundary, so this waits on revisiting the sandbox.
