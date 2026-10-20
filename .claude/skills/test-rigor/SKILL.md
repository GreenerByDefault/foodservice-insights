---
name: test-rigor
description: Pass the tests for a file or diff against AGENTS.md's testing philosophy — coverage, assertion rigor, and noise
argument-hint: "[path or git ref, defaults to the whole branch]"
allowed-tools: Bash(git fetch *), Bash(git diff *), Bash(git merge-base *), Bash(git status), Read, Edit, Write
---

Apply [`AGENTS.md`](../../../AGENTS.md) § Testing philosophy to the tests covering `$ARGUMENTS`
(a path or git ref). That section is the source of truth for what a good test is; this skill is
the pass over the files. With no argument, the scope is everything since `origin/main`, committed
or not: run `git fetch origin main` first (the local `main` is often behind), then
`git diff $(git merge-base origin/main HEAD)`.

For each test file in scope, read it alongside the source it tests and make three passes:

1. **Coverage.** Walk the source's branches, error paths, and boundary conditions and add a test
   for each one missing. Skip inputs the type system already makes impossible, and test a
   dependency that carries its own guarantee only at the integration point.
2. **Assertion rigor.** Tighten assertions that check less than they appear to — a partial match
   where full equality would work. Where the full value truly is noisy, keep the partial match
   and say why in the diff.
3. **Noise.** Cut or merge tests that duplicate another test's coverage, assert what the type
   system or a library already guarantees, or test implementation detail rather than behaviour.
   A brittle test (exact wording of an incidental error message, a snapshot of a large unstable
   structure) is a candidate too.

Load [`.claude/rules/typescript.md`](../../rules/typescript.md) or
[`.claude/rules/python.md`](../../rules/python.md) for whichever stack you're in before touching
test files, if it hasn't already loaded — each has file-layout and runner conventions that
affect where a new test goes and how it's named.

When a call is borderline, make the judgment call and say why rather than asking — but flag it in
the report so it's easy to double check.

Report, per file: tests added (and what edge case each covers), assertions tightened, and tests
removed or merged (and why). Then run the stack's verification gate from `AGENTS.md` § Verifying
a change and report the result.
