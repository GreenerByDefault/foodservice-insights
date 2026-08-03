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
