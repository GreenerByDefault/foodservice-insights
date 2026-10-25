---
paths:
  - "contract/**"
  - "apps/worker/src/contract/**"
  - "python/worker_child/worker_child/contract/**"
  - "python/worker_child/tests/contract/**"
  - "python/worker_child/worker_child/run.py"
  - "python/worker_child/worker_child/writer.py"
  - "python/worker_child/tests/support/contract_fixtures.py"
---

# The worker contract

`contract.json` and its fixtures change together, and both stacks parse them, so a contract change
has to pass both gates. [`contract/README.md`](../../contract/README.md) has the procedure.
