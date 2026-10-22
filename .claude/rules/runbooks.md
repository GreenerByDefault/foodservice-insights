---
paths:
  - "docs/runbooks/**"
---

# Runbooks

- **Read or write a runbook; never perform one.** Each is run by a person against production, and
  the hosted CLIs are denied to agents on purpose. Stop and hand the steps to a human.
- **The repo is public.** Never put a credential, connection string, address, hostname, account
  id or deep link into a console in a runbook.
- **[`docs/runbooks/README.md`](../../docs/runbooks/README.md) § Writing one is the rest of the
  conventions.** Read it before writing one.
