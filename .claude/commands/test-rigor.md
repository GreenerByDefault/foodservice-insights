---
description: Pass the tests for a file or diff against AGENTS.md's testing philosophy — coverage, assertion rigor, and noise
argument-hint: "[path or git ref, defaults to the whole branch]"
allowed-tools: Bash(git diff *), Bash(git merge-base *), Bash(git status), Read, Grep, Glob, Edit, Write
---

Apply [`AGENTS.md`](../../AGENTS.md) § Testing philosophy to the tests covering `$ARGUMENTS`
(a path or git ref), or `git diff main...HEAD` plus `git diff HEAD` for uncommitted work if
nothing is given. For each test file in scope, read it alongside the source it tests and make
three passes:

1. **Coverage.** Walk the source's branches, error paths, and boundary conditions (empty/null
   input, off-by-one edges, the failure side of a validation) and check each has a test. Add the
   ones that are missing. Skip inputs the type system already makes impossible. For anything
   with its own guarantee — standard library, third-party dependency, or a first-party leaf
   module with its own exhaustive tests — don't re-derive its cases; test the integration point
   instead (does this code call it correctly, handle the edges it exposes, and compose it with
   the rest of the pipeline).
2. **Assertion rigor.** Flag or fix assertions that check less than they appear to. Prefer
   `toEqual` (or the stack's full-equality equivalent) over a partial-match assertion like
   `toMatchObject` — a partial match lets an unexpected or wrong field through silently. Loosen
   back to a partial match only where the full value is noisy or beside the point (a timestamp,
   a generated id), and say why in the diff, not as a default.
3. **Noise.** Cut or merge tests that duplicate coverage another test already has, assert
   something trivial the type system or a library already guarantees, or test implementation
   detail rather than behavior. A flaky or overly brittle test (asserting exact wording of an
   incidental error message, snapshotting a large unstable structure) is a candidate too.

Load [`.claude/rules/typescript.md`](../rules/typescript.md) or
[`.claude/rules/python.md`](../rules/python.md) for whichever stack you're in before touching
test files, if it hasn't already loaded — each has file-layout and runner conventions that
affect where a new test goes and how it's named.

When a call is borderline (an edge case that's plausible but maybe not meaningful, an assertion
that's partial but the full value truly is noisy), make the judgment call and say why rather than
asking — but flag it in the report so it's easy to double check.

Report, per file: tests added (and what edge case each covers), assertions tightened, and tests
removed or merged (and why). Then run the stack's verify command
(`pnpm lint && pnpm check && pnpm test` or `just lint && just check && just test`) and report the
result.
