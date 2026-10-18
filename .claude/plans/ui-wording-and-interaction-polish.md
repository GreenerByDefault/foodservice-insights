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

Two findings from exploring the code shaped the upload form:
- **"Leave the weight off" is taken to mean leave the *unit* off the weight.** The weight column is
  required at every layer.
- **GBD's own sample distributor export is rejected today.**
  `python/lab/test_data/raw_data/sample_raw_purchasing.csv` names its columns `Weight (lbs)` and
  `Product Description`, and neither is recognized. As decided, the reader will accept both and take
  the weight unit from the header.

What's left is two PRs. PR 1 teaches the CSV reader the new headers and rejects a unit mismatch on
the server, with no visible UI change. PR 2 rewrites the upload form on top of it, locks the radio
to the file's unit, and regenerates only `new-report/*` screenshots.

---

## PR 1: Accept a unit in the weight header, and "Product description"

This PR stands alone because the server check ships with it. Until PR 2 lands, a file whose header
names a unit that doesn't match the form is rejected with a clear message, rather than having its
weights saved in the wrong unit. No screenshots change.

### Reader (`lib/reports/csv/`)
**`read/columns.ts`**
- Weight headers:
  - Recognize `weight` or `product weight` followed by a lb or kg unit, after
    `normalizeHeaderName`:
    - shapes: `Weight (lbs)`, `Weight lbs`, `weight_kg`, `Weight (in pounds)`
    - unit tokens: lb, lbs, pound(s), kg, kgs, kilo(s), kilogram(s)
  - `resolveHeader` returns the unit the header names, as `weightUnit?: UnitSystem`.
- Add `product description` and `item description` as product aliases.
  - Trade-off: a file with both a "Product" and a "Product description" column becomes ambiguous
    and is rejected. That matches how "Item" plus "Description" is already handled.
- Update the file's header comment. It argues for a tiny alias list. That still holds, because
  these additions name the same thing and none of them is spend or a count.

**Units we can't use.** A weight header naming any other unit (oz, ounces, g, grams, ton or tons)
gets a new `HeaderFault`, in place of "missing". `describe/file.ts` turns it into:
*"Your weight column "Weight (oz)" is in ounces. Convert the weights to lb or kg, and name the
column "Weight"."*

**Carry the unit through**
- From `read/layout.ts`, to `normalize.ts` (`CsvNormalization`), to `lib/reports/inspect-file.ts`
  (`FileInspection`). Nothing in the form reads it yet.
- `excel/sheets.ts` already calls `resolveHeader`, so workbook sheet picking gets the new names for
  free.

### On the server
`lib/reports/submission.ts` re-checks after `normalizeCsv`. It is authoritative, like every other
check. A mismatch is rejected with `invalid_metadata`:
*"Your file's weight column is in lb, but the form says kg. Choose lb and upload again."*

The Python worker is unaffected, because `write.ts` always writes the header `product,date,weight`.

### CSV wording fixes
- `lib/reports/csv/describe/rows.ts`: "recognise" becomes "recognize" in two rules.
- `lib/reports/csv/README.md:59`: stop saying semicolons and Windows-1252 are rejected, because the
  code accepts both. Mention unit-bearing weight headers.

### Tests
- `read/columns.test.ts`:
  - each unit header shape, for lb and kg
  - an unsupported unit
  - the product-description aliases
  - the new ambiguity
- `describe/file.test.ts`: the unsupported-unit message.
- `normalize.test.ts` / `inspect-file.test.ts`: `weightUnit` comes through. Add a test that the GBD
  lab sample's header row (`Date,Product Description,Total Amount ($),Weight (lbs),Sales,,`) is
  accepted with `lb`.
- `submission.test.ts`: the mismatch rejection.
- `rows.test.ts`.

---

## PR 2: Upload form, with clear instructions and friendlier file checks

Builds on PR 1's `FileInspection.weightUnit`.

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
- The `csv/` modules run in the browser too, so keep them free of server-only imports.

## Verification
1. While iterating, run only the touched test files:
   - `pnpm --filter @gbd/web test:unit <file>`. Vitest's filter is not a literal path, so a path
     through `[organizationSlug=slug]` matches nothing; pass a substring such as
     `reports/new/upload-form` instead.
   - `pnpm turbo run test:e2e --filter=@gbd/web -- <file>`, through Turbo so the build is fresh.
2. PR 2 only: regenerate baselines with `pnpm turbo run screenshots:update --filter=@gbd/web`. Going through
   turbo avoids a stale build. To scope it to one spec, pass the update mode before the path
   (`-- changed e2e/new-report/<spec>`): the script ends in `--update-snapshots`, which otherwise
   takes the path as its mode.
3. PR 2 only: **read the regenerated PNGs** (desktop, tablet and mobile) for every changed page:
   - check that the wording wraps sensibly at 375px
   - check that nothing unrelated changed
4. Run the gate in the background: `pnpm lint && pnpm check && pnpm test`. Report flaky tests
   rather than chasing them.
5. Check by hand in the running app (`/run` or Playwright MCP):
   - PR 1: upload a copy of the lab sample CSV with lb chosen and confirm it is accepted, then
     with kg and read the mismatch rejection; upload `Weight (oz)` and read the rejection
   - PR 2: upload the lab sample and confirm Weight unit locks to lb; upload
     `apps/web/sample-reports/valid.csv` and confirm both radios stay open
