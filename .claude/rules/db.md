---
paths:
  - "packages/db/**"
---

# The database package

- **Write migration columns in snake_case.** `CamelCasePlugin` translates identifiers, so a
  `site_name` column is what makes `siteName` work in queries.
- **[`packages/db/README.md`](../../packages/db/README.md) § Conventions and § Writing a
  migration are this package's rules.** Read them before changing the schema.
