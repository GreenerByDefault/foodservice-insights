# Sample reports

Files to upload by hand at `/orgs/<id>/reports/new` while running `pnpm dev` — not read by any
test. `valid.csv` stays on one month so the form's month-count field only asks for one number.

| File | What happens |
| --- | --- |
| `valid.csv` | accepted |
| `missing-column.csv` | rejected — no `weight` column |
| `bad-rows.csv` | rejected — a unit stuck to a weight, an empty product |
| `empty.csv` | rejected — header, no rows |

Not exhaustive: `apps/web/src/lib/reports/csv/normalize.test.ts` covers the rest of what
`normalizeCsv` rejects.
