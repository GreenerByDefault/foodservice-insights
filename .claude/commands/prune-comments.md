---
description: Delete or relocate the comments in your diff that do not earn their place
argument-hint: "[path or git ref, defaults to the whole branch]"
allowed-tools: Bash(git diff *), Bash(git merge-base *), Read, Edit
---

Prune the comments this branch adds, against the rules in `AGENTS.md` § Comments.

Scope: `$ARGUMENTS` if given, otherwise the whole branch — `git diff main...HEAD` plus
`git diff HEAD` for uncommitted work.

Consider only **added** comment lines. Comments that were already on `main` are out of scope
even if you disagree with them, and non-comment lines must not change.

Delete a comment when it:

- narrates the design of a function whose signature already shows it — the shape is a summary
  line, a blank `*`, then a paragraph of rationale, and the fix is to keep the summary and drop
  the paragraph;
- restates the test name above the test;
- replaces the reasoning with a pointer — "see `ARCHITECTURE.md` § Auth" instead of the fact.
  Citing a doc as the *source* of a fact is not this, and stays;
- justifies a mechanical choice the code already shows, narrates tooling, or reassures the
  reader that nothing else has to change.

Relocate rather than delete when the rationale states something a reader could not recover from
the code: move it out of the doc comment and onto the line it defends.

Keep, without touching:

- a file's map — a layout, a contract, or invariants that hold across the whole file. These run
  long on purpose; `packages/storage/src/keys.ts` opens with 21 lines and every one earns its
  place. Length is never the reason to cut.
- any comment stating a fact unavailable from the code, the types, or the test name: a bit
  width, a nullable upstream column, a cross-language trap, a chosen ordering, a security
  invariant.

When a comment is borderline, keep it and say so in your summary rather than cutting it. Report
what you deleted, what you moved, and what you left borderline.
