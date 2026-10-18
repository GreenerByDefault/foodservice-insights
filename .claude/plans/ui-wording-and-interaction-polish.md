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

The work is split into two independent PRs off `main`. Each touches its own files and regenerates
only its own screenshots.

---

## PR 1: Members page, with the invite form in a modal

**Add the dialog component.** Run `pnpm dlx shadcn-svelte@latest add dialog` in `apps/web`. It
lands in `lib/components/ui/dialog/`, the same way `alert-dialog` was added. The bits-ui patch only
touches pin-input, so it doesn't affect dialogs.

**`members/+page.svelte`**
- H1 and `pageTitle` become **"Organization members"**, like "Organization settings". The tab
  label stays "Members".
- Admins get an **"Invite someone"** button in `PageHeading`'s `actions` snippet, the way Reports
  has "New report".
- The inline "Invite someone" section is removed.
- "Pending invitations" and "Your membership" stay as they are.

**New `members/invite-dialog.svelte`** wraps the existing `InviteForm`:
- Title: **"Invite someone to {org name}"**
- Description: *"We'll email them a link to join. The invitation lasts {INVITE_LIFETIME_DAYS}
  days."* The constant comes from `@gbd/core` and is currently 14.
- Footer buttons: **Cancel** and **Send invitation**.
- Closing the dialog resets the form and its messages. Focus returns to the trigger, which bits-ui
  handles.

**`members/invite-form.svelte`**
- Add an `onInvited` callback. The dialog closes only on created + `emailSent`, and the existing
  "Invited x" toast still fires.
- Every other outcome stays inline inside the dialog, following the README's rule that problems are
  shown where they happen.
- Role radios stack vertically, each with a description wired to `aria-describedby`:
  - **Member**: *"Can see and upload reports."*
  - **Admin**: *"Can also invite and remove people, and manage the organization."* This matches
    the roles table in `REQUIREMENTS.md`.
- New text for the unknown-outcome message, since the modal now hides the list it used to point at:
  *"We couldn't tell whether that invite was sent. Close this and check Pending invitations. If it's
  not there, try again."*
- When the email failed to send, keep the address in the field instead of clearing it, so pressing
  "Send invitation" again retries.

**`members/pending-invite-row.svelte`.** "Revoke" becomes plainer wording:

| Element | Now | New |
|---|---|---|
| Button | Revoke | **Cancel invite** |
| Accessible name | Revoke invite for {email} | Cancel invite for {email} |
| Toast | Revoked the invitation for {email} | Canceled the invitation for {email} |
| Error | Couldn't revoke this invite — please try again. | Couldn't cancel this invite — please try again. |

**Tests.** These flows now open the dialog first.
- `invite-form.svelte.test.ts`
- A new `invite-dialog.svelte.test.ts`, covering:
  - it closes on success
  - it stays open with each inline message
  - it resets when closed
- `pending-invite-row.svelte.test.ts`
- `e2e/organizations/invites.e2e.ts`
- `e2e/organizations/members.screenshot.ts`:
  - the heading at lines 92 and 134
  - the invite-state shots, which now capture the open dialog

**Screenshots:** `organizations/members-*`.

## PR 2: Upload form, with clear instructions and friendlier file checks

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

### Accept a unit in the weight header, and "Product description" (`lib/reports/csv/`)
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

**Carry the unit through to the form**
- From `read/layout.ts`, to `normalize.ts` (`CsvNormalization`), to `lib/reports/inspect-file.ts`
  (`FileInspection`).
- `excel/sheets.ts` already calls `resolveHeader`, so workbook sheet picking gets the new names for
  free.

**In the form**
- When the file's header names a unit:
  - Weight unit is set to that unit.
  - The other radio is disabled, so a mismatch can't be entered.
  - The hint becomes *"Set by your file's "Weight (lbs)" column."*
- Replacing the file resets all of this.

**On the server.** `lib/reports/submission.ts` re-checks after `normalizeCsv`. It is authoritative,
like every other check. A mismatch is rejected with `invalid_metadata`:
*"Your file's weight column is in lb, but the form says kg. Choose lb and upload again."*

The Python worker is unaffected, because `write.ts` always writes the header `product,date,weight`.

### Wording fixes in the same flow
- `reports/new/monthly-counts.svelte`: "1 of 1 months still need a count" gets correct grammar.
  - Examples: *"1 of 1 month still needs a count"* and *"2 of 4 months still need a count"*.
  - The noun follows the total, and the verb follows how many are missing.
- `lib/reports/csv/describe/rows.ts`: "recognise" becomes "recognize" in two rules.
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
- `submission.test.ts`:
  - the mismatch rejection
  - field labels (line 108)
- `monthly-coverage` tests.
- `upload-form.svelte.test.ts`:
  - hint texts (lines 279–307)
  - months-progress strings
  - the radio is set and the other disabled for a file with a unit header
  - it resets on Replace
- `monthly-counts.svelte.test.ts`, `rows.test.ts`.
- `e2e/new-report/new-report.e2e.ts`:
  - the `kg` radio needs `exact` or the full label
  - months text at lines 26, 99 and 133
- `tests/e2e/specs/report-lifecycle.e2e.ts`: form labels at lines 38–46.

**Screenshots:** `new-report/*`.

---

## Implementation notes
- Hand self-contained `.svelte` edits to the `svelte-file-editor` subagent, or run
  `svelte-autofixer` on each file.
- Every page must still call `pageTitle(`, because `page-titles.test.ts` scans for it.
- The `csv/` modules run in the browser too, so keep them free of server-only imports.

## Verification, for each PR
1. While iterating, run only the touched test files:
   - `pnpm --filter @gbd/web test:unit <file>`
   - `pnpm --filter @gbd/web test:e2e -- <file>`
2. Regenerate baselines with `pnpm turbo run screenshots:update --filter=@gbd/web`. Going through
   turbo avoids a stale build.
3. **Read the regenerated PNGs** (desktop, tablet and mobile) for every changed page:
   - check that the wording wraps sensibly at 375px
   - check the dialog's layout on mobile
   - check that nothing unrelated changed
4. Run the gate in the background: `pnpm lint && pnpm check && pnpm test`. Report flaky tests
   rather than chasing them.
5. Check by hand in the running app (`/run` or Playwright MCP):
   - **PR 1:**
     - open the dialog, invite someone, and confirm it closes with a toast
     - invite an existing member and confirm the inline error stays in the dialog
     - press Escape and confirm the form resets and focus returns to "Invite someone"
   - **PR 2:**
     - upload a copy of the lab sample CSV and confirm Weight unit locks to lb
     - upload `Weight (oz)` and read the rejection
     - upload `apps/web/sample-reports/valid.csv` and confirm both radios stay open
