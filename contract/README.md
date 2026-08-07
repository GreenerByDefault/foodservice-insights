# The worker parent ↔ child contract

The parent (`apps/worker`, TypeScript) sets up a run directory and spawns the child
(`python/worker_child`, Python) to read and write it. That directory is the only seam between the
two stacks. This directory is its source of truth.

- [`contract.json`](contract.json) — every name both sides must agree on: paths within the run
  directory, the invocation shape, the exit codes, and who may claim each failure reason. Neither
  side reads it at runtime; both copy it into their own constants and assert equality in a unit
  test.
- [`fixtures/valid/`](fixtures/valid/) — one golden document per message. The side that *writes*
  a message in production asserts its writer reproduces the fixture; the side that *reads* it
  asserts its parser accepts it.
- [`fixtures/invalid/`](fixtures/invalid/) — one semantic violation each. Both sides assert they
  reject every fixture for a message they parse.

The layout itself, and why it is shaped this way, is documented on
[`apps/worker/src/contract/layout.ts`](../apps/worker/src/contract/layout.ts).

## Changing the contract

1. Edit `contract.json` and the fixtures together.
2. Update both halves: `apps/worker/src/contract/` and
   `python/worker_child/src/worker_child/`.
3. `pnpm lint && pnpm check && pnpm test` and `just lint && just check && just test`.

Two constraints on fixtures. Every file under `invalid/` must be **syntactically valid JSON** —
Biome parses this directory in CI, so malformed bytes belong in a test that generates them.
And both sides compare **parsed values, never bytes**, because Biome also formats these files.

A change anywhere under `contract/` runs both stacks' CI jobs, which is the point of this
directory living at the repo root — see the comment at the top of
[`.github/filters.yml`](../.github/filters.yml). Prose in this README does not: `!**/README.md`
excludes it from both filters, so nothing enforceable may live here.
