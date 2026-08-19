---
description: Fold a landed precursor PR back into its plan file, so the plan reads fresh for what's left
argument-hint: "<plan-file-path> [merged-commit-sha]"
allowed-tools: Bash(git diff *), Bash(git show *), Bash(git merge-base *), Bash(git log *), Bash(git status), Read, Grep, Glob, Edit, Write
---

`$ARGUMENTS` is `<plan-file-path> [merged-commit-sha]`.

## Scope the diff

- `merged-commit-sha` given → the precursor already squash-merged to `main`. Diff is
  `git show <sha>` (plus `git show --stat <sha>` for the file list).
- Omitted → still on the unmerged branch, queued to merge. Diff is
  `git diff $(git merge-base main HEAD)...HEAD`.

Read the full diff, not just the stat — the follow-up commits are where a rename, a signature
change, or a reversed decision actually happened, and the stat won't show you that.

## Find the seam

Read the plan file at `<plan-file-path>` in full. Match the diff's file list against the plan's
first not-yet-landed `## PR N` section — that's almost always the one this diff implements. If the
diff spans two PR sections or only partially covers one, say so before doing anything else; don't
guess silently.

## Rewrite, don't annotate

The output is a plan that reads as if freshly written for what remains — not a diff, not a
changelog, not the old plan with strikethrough. Concretely:

1. **Delete the landed PR's own section wholesale.** Its task list, its "Tests" and file-by-file
   detail — that's an instruction for work that's done. None of it belongs in a plan whose
   audience is the next PR's implementer.
2. **Carry forward only what's load-bearing.** If a decision, invariant, or rationale from that
   section still constrains a *later* PR, fold it into `## Context` or `## Decisions` — in the
   plan's own voice, not quoted from the deleted section. If nothing later depends on it, let it
   go; it's in the PR's own commit history if anyone needs it.
3. **Reconcile every reference against what actually shipped, not what was planned.** Walk
   `Context`, `Decisions`, and every remaining `## PR N` section for filenames, function names,
   types, and API shapes the diff changed — a rename, a signature that grew a parameter, a
   decision that was reversed mid-review. Read the current file at that path (via Grep/Glob/Read)
   before asserting it still matches; the plan is very often stale here even on small precursors.
   A follow-up commit that changed course between PR 1 and its own last commit is what future PRs
   need to see reflected — not the first-draft version.
4. **Renumber what's left starting at PR 1.** The reader implementing the next PR shouldn't have
   to know three PRs used to precede it.
5. **Keep the plan's existing density and prose style** — this file is closer to a design doc than
   a checklist (see how `## Decisions` reads: `Accepted: ...`, `Considered, not done: ...`). Match
   that register in whatever you add or reword; don't flatten it into bullet-point terseness.
6. **Update `## Verification`** if it named steps specific to the landed PR (e.g. a manual QA step
   for UI that PR built) — drop what's now covered by the merged PR's own tests, keep what still
   applies to what's left.

## Report

Before writing, summarize: which PR section was folded in, what got promoted into Context/Decisions
(and why it's load-bearing), and every reference you changed because the code diverged from the
plan (old → new). Then write the file and note the new PR numbering.
