---
description: Bring a Claude Code plan mode plan into `.claude/plans/` under a name that will still route correctly months later
argument-hint: "[source-path] [feature-name]"
allowed-tools: Bash(ls *), Bash(cat *), Bash(head *), Bash(cp *), Read, Write, Glob
---

Plan mode writes to `~/.claude/plans/` under a name generated from the opening words of the
prompt that started it — `i-want-to-implement-kind-lovelace.md`. That name cannot route:
`AGENTS.md` § Plans has agents pick plans by filename alone, so the name *is* the index. This
command fixes the name and brings the plan into the repo.

## Find the source

`$ARGUMENTS` may be a source path, a feature name, both, or nothing.

- Path given → use it.
- Otherwise → the plan for the work in this conversation. If plan mode wrote it this session it
  is the most recently modified file in `~/.claude/plans/` (`ls -t ~/.claude/plans/ | head -5`).
  Confirm against its `# Title` and opening paragraph before copying, and ask rather than guess
  if the newest few are all plausible.
- If the plan exists only in this conversation and was never saved, write it out directly.

## Name it

Derive the filename from the plan's `# Title`, not from the prompt that produced it: kebab-case,
articles dropped — `# The report page` → `report-page.md`. The test is whether someone handed an
unrelated task can tell from the filename alone whether this plan bears on it. Prefer the
feature's name in the product over the mechanism that implements it, and drop `plan`, `new`, and
`implement` — every file in the directory is a plan for something that does not exist yet.

A collision with an existing plan usually means the two are the same work. Say so and ask; do
not resolve it by appending a number.

## Copy it verbatim

This command is a rename, not an edit — the content is copied unchanged. If the plan has no
`## PR N` sections for `/plan-advance` to fold in, or no `## Context`, say so, because the
lifecycle in `AGENTS.md` § Plans has nothing to grip. Still copy it.

Report the source path, the new path, and why the name is the one that will route.
