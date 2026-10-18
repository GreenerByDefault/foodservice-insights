# UI wording & interaction polish

## Context
The site works end to end. This pass makes it easier for non-technical foodservice staff to use,
through clearer wording and simpler interactions, without adding long explanations. Visual styling is
out of scope; a later session will align the site with GBD's design.

The account, invitations and organizations pages already use this voice. Pages that belong to
the user say so ("Your account", "Your invitations", "Your organizations"). An organization's own
pages name it ("Organization settings"), while their tabs keep the short label ("Settings"). An
empty list gets a card with one sentence and the next action, as in `invites/invite-offers.svelte`
and `reports-list/reports-list.svelte`.

The upload form rests on two findings from exploring the code:
- **"Leave the weight off" is taken to mean leave the *unit* off the weight.** The weight column is
  required at every layer.
- **A weight header may now name its unit.** The CSV reader accepts `Weight (lbs)`, `weight_kg`,
  `Weight (in pounds)` and the like, plus `Product description` and `Item description` as product
  aliases. `FileInspection.weightUnit` (from `lib/reports/inspect-file.ts`) carries the unit when
  the header names one and is absent otherwise. A header in ounces, grams or tons is rejected by
  name rather than as a missing column.

The server is already authoritative about the unit: `lib/reports/submission.ts` rejects a form
whose Weight unit disagrees with the header, with `invalid_metadata` and *"Your file's weight
column is in lb, but the form says kg. Choose lb and upload again."* Locking the radio below is so
the user never sees that message, not what keeps weights in the right unit.

GBD's sample distributor export, `python/lab/test_data/raw_data/sample_raw_purchasing.csv`, has a
real header on line 6 (`Weight (lbs)`, `Product Description`), which now reads. Its line 1 is a
second, machine-written header (`date,product,total_amount,weight_lbs,…`) that also reads, so the
file as committed is rejected with *"Lines 1 and 6 each look like a header row…"*. Delete line 1 of
a copy to try it in the app.

What's left is one PR: rewrite the upload form on top of that, lock the radio to the file's unit,
and regenerate only `new-report/*` screenshots.

---

## PR 1: Upload form, with clear instructions and friendlier file checks

Builds on `FileInspection.weightUnit`.

### Form wording (`reports/new/upload-form.svelte`)
Weight unit moves out of "Report details" and into a reorganized **"Purchasing data"** fieldset,
because it describes the file:
1. *"A CSV or Excel file of your food purchases, up to 10MB, with these three columns:"*
2. A small example `<table>`, with an sr-only caption "Example file":

   | Product | Date | Weight |
   |---|---|---|
   | Chicken breast | 2026-01-05 | 40 |
   | Whole milk | 2026-01-05 | 34.4 |
   | Carrots, diced | 2026-01-12 | 18.25 |

3. *"Write weights as plain numbers, with no "lb" or "kg" next to them. Any other columns are
   ignored."*
4. The drop zone. Its `aspect-video` in `ui/file-drop-zone/file-drop-zone-trigger.svelte` makes it
   about 380px tall on desktop. Swap it for fixed padding so the example doesn't make the form
   longer overall. This is the only layout tweak, and the component is used in one place.
5. **Weight unit**:
   - Hint: *"The unit for the numbers in your weight column."*
   - Radio labels: **lb (pounds)** and **kg (kilograms)**. These now match exactly what
     `upload-details.svelte` echoes back (`UNIT_NAMES`).

The other fieldsets:
- **Report name** gets a hint: *"For example, Q1 2026 purchases."*
- **Site name** keeps its hint.
- "Diners or meals served" is unchanged. `.claude/plans/optional-diner-and-meal-counts.md` will
  change that fieldset.

### Lock the unit to the file's header
- When the file's header names a unit:
  - Weight unit is set to that unit.
  - The other radio is disabled, so a mismatch can't be entered.
  - The hint becomes *"Set by your file's "Weight (lbs)" column."*
- Replacing the file resets all of this.

### Wording fixes in the same flow
- `reports/new/monthly-counts.svelte`: "1 of 1 months still need a count" gets correct grammar.
  - Examples: *"1 of 1 month still needs a count"* and *"2 of 4 months still need a count"*.
  - The noun follows the total, and the verb follows how many are missing.
- `lib/reports/submission.ts`: the fallback "Check these fields: countsBasis, unitSystem." names
  fields by their form labels instead:
  - Report name
  - Site name
  - Count by
  - Weight unit
  - Diners or meals per month

  Add a label map next to `FIELD` in `metadata.ts`.
- `lib/reports/monthly-coverage.ts`: show months as "January 2026", not `2026-01`, using the
  existing `formatMonth` in `monthly-counts.ts`. The machine-readable `rejectionDetail` stays as it
  is.

### Tests
- `submission.test.ts`: field labels (line 108).
- `monthly-coverage` tests.
- `upload-form.svelte.test.ts`:
  - hint texts (the `hints` block)
  - months-progress strings
  - the radio is set and the other disabled for a file with a unit header
  - it resets on Replace
- `monthly-counts.svelte.test.ts`.
- `e2e/new-report/new-report.e2e.ts`:
  - the `kg` radio needs `exact` or the full label
  - the three "… months still need a count" assertions
- `tests/e2e/specs/report-lifecycle.e2e.ts`: form labels at lines 38–46.

**Screenshots:** `new-report/*`.

---

## Implementation notes
- Hand self-contained `.svelte` edits to the `svelte-file-editor` subagent, or run
  `svelte-autofixer` on each file.
- Every page must still call `pageTitle(`, because `page-titles.test.ts` scans for it.

## Verification
1. While iterating, run only the touched test files:
   - `pnpm --filter @gbd/web test:unit <file>`. Vitest's filter is not a literal path, so a path
     through `[organizationSlug=slug]` matches nothing; pass a substring such as
     `reports/new/upload-form` instead.
   - `pnpm turbo run test:e2e --filter=@gbd/web -- <file>`, through Turbo so the build is fresh.
2. Regenerate baselines with `pnpm turbo run screenshots:update --filter=@gbd/web`. Going through
   turbo avoids a stale build. To scope it to one spec, pass the update mode before the path
   (`-- changed e2e/new-report/<spec>`): the script ends in `--update-snapshots`, which otherwise
   takes the path as its mode.
3. **Read the regenerated PNGs** (desktop, tablet and mobile) for every changed page:
   - check that the wording wraps sensibly at 375px
   - check that nothing unrelated changed
4. Run the gate in the background: `pnpm lint && pnpm check && pnpm test`. Report flaky tests
   rather than chasing them.
5. Check by hand in the running app (`/run` or Playwright MCP): upload the lab sample with its
   line 1 deleted and confirm Weight unit locks to lb; upload `apps/web/sample-reports/valid.csv`
   and confirm both radios stay open.
