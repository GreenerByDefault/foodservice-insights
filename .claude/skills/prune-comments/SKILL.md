---
name: prune-comments
description: Delete or relocate the comments in your diff that do not earn their place
argument-hint: "[path or git ref, defaults to the whole branch]"
allowed-tools: Bash(git fetch *), Bash(git diff *), Bash(git merge-base *), Bash(git status), Read, Edit
---

Apply [`AGENTS.md`](../../../AGENTS.md) § Comments to the comments this branch adds. That section is
the only source of truth for which comments earn their place — this skill is just the pass over the
diff.

Scope: `$ARGUMENTS` if given, otherwise everything since `origin/main`, committed or not: run
`git fetch origin main` first (the local `main` is often behind), then
`git diff $(git merge-base origin/main HEAD)`.

- Consider only **added** comment lines. Comments already on `main` are out of scope even if you
  disagree with them, and no non-comment line may change.
- Prefer moving a comment over deleting it. Rationale that states something unrecoverable belongs
  on the line it explains, not in the doc comment above.
- When a comment is borderline, keep it and flag it. A comment you should have cut is cheaper
  than one you should not have.

Report what you deleted, what you moved, and what you left borderline.
