---
paths:
  - "contract/**"
  - "apps/worker/src/contract/**"
  - "python/worker_child/worker_child/contract/**"
  - "python/worker_child/tests/contract/**"
---

# The worker contract

`contract.json` and its fixtures change together, and both stacks parse them, so a contract change
has to pass both gates. [`contract/README.md`](../../contract/README.md) has the procedure.
