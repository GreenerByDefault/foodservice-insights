# Whole-system end-to-end tests

**This directory is intentionally empty.** It is a placeholder for the tier of tests that
cannot exist yet.

## What will live here

End-to-end tests that exercise more than one component of the stack at once:

```
browser -> web app -> Postgres -> worker parent -> Python child -> blob store
```

The canonical example is the full report lifecycle: upload a CSV, watch the report move
through `pending` -> `processing` -> `complete`, and download the resulting PDF. That
test needs the web app, a database, a running worker, and a fake LLM, so it cannot live
inside any single package. It will become its own workspace package, `@gbd/e2e`.

## Why it is empty

Phase 1 of this repo is boilerplate only. There is no database (Phase 2) and no worker or
Python child process (Phase 3), so there is no system to test end to end yet.

## Where e2e tests live today

End-to-end tests that need **only the web app** — page rendering, auth flows, navigation —
live in [`apps/web/e2e/`](../../apps/web/e2e) and run with
`pnpm --filter @gbd/web test:e2e`. That split is deliberate and permanent: web-only
journeys stay next to the web app, where they are fast and cheap to run, and only tests
that genuinely span components pay the cost of booting the whole stack.

Both suites use the `*.e2e.ts` suffix so Playwright and vitest can never pick up each
other's files.
