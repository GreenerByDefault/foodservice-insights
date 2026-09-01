# New report upload form

## Context

The form landed.
[`upload-form.svelte`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/new/upload-form.svelte)
is real and wired into
[`+page.svelte`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/new/+page.svelte): the
drop zone, report details, monthly counts, and submit handler all work, `uploadReport` posts to
`POST /api/orgs/[organizationId]/reports`, and `parseUploadRejection` accepts both the 400 a bad
file produces and the 429 a rate limit produces. `apps/web/README.md`'s `## Forms`, `## Errors`, and
`## Calling the API from the browser` sections now carry the conventions that work established —
native constraint validation and the hidden-control trap, the outcome-union pattern for a feature
client, the three failure surfaces, the announcement rules — so none of that is re-argued here.

What shipped in that PR is deliberately unfinished in one place:
[`rejection-view.svelte`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/new/rejection-view.svelte)
renders a `UploadRejection` correctly but plainly — the summary as a heading, the date-order
problem and every row problem as bare paragraphs — with a comment on the component saying so. This
plan is now only about designing that view. Its contract is already fixed by the code that calls
it: props are `rejection: UploadRejection` and `onBack: () => void`, it never switches on `reason`,
and it renders identically whether the rejection came from the browser's own `inspectFile` or a
server 400/429. So this is layout and hierarchy, not behavior.

### Two consequences that still shape the design

**The browser runs the real normalizer**, so a rejected file is normally never uploaded at all — a
server rejection is the rare path (a stale tab, a limit that moved). Both paths reach this same
component, so **the view must not write a sentence about the user's file**: every sentence a reader
sees has to already be in the `UploadRejection` payload, produced by `describe/`. If the screen
ever wants copy that is not in the payload, that copy is added in `describe/findings.ts`, not here.

**The view swap must not eat typed work.** `upload-form.svelte` already keeps every field's value in
its own `$state`, so remounting the form after **Back to the form** restores everything — this PR
does not have to think about that trap, only render the view that swaps in.

## What a rejection actually looks like

This is the hardest part of the form, and it can't be designed without knowing what `csv/describe/`
produces. There are two structurally different shapes.

### Shape A — we could not read the file at all

`describeUnreadableFile` returns a `summary` and nothing else. Reasons: `unparseable`,
`bad_columns`, `empty`, `too_large`. Every one is a single sentence naming a single fix:

- "That looks like an Excel (.xlsx) file, not a CSV. Save it as CSV and upload it again."
- "Your file needs a column for product name and date ordered."
- "Two columns could be the weight: "weight", "net weight". Remove or rename one."
- "The quotes starting on line 42 are never closed, so we cannot tell where that row ends."
- "We can't tell what separates your columns — this file could be split into columns more than one
  way. Save it as CSV (comma separated values) and upload it again."
- "That file has more than 25 columns, far past what we can read." / "That file has no rows in it."

One line, one action. **An `Alert` beside the drop zone is the whole design.**

**A sibling to Shape A, not a member of it: rate limiting.** `describeRateLimitExceeded` in
[`rate-limit.ts`](apps/web/src/lib/server/reports/rate-limit.ts) produces the same
`RejectedUploadRecord` shape as `describeUnreadableFile` — one `summary`, no `rowProblems` or
`dateOrderProblem` — so it renders through the exact same view with no new fields. This is why
**Back to the form**, not "Choose a different file", is the button's label: it is the accurate
description of what the button does for every reason, including this one, where the file was never
the problem.

### Shape B — we read it and rows failed

`describeFindings` returns `reason: 'bad_rows'`, and it can be large:

- `summary` — "We found problems in 4,102 of your 4,500 rows. Showing 20 of 23 things to fix."
- `dateOrderProblem?` — one long prose sentence. **File-wide and fatal**: "Your dates are written
  both ways: row 7 has "13/02/2026", which can only be day first, and row 12 has "02/13/2026",
  which can only be month first. Re-save the date column as YYYY-MM-DD and upload again."
- `rowProblems?` — up to `MAX_PROBLEMS_REPORTED`, which is **20**. Each `Problem` is four fields:

  | Field | Example | Bound |
  | --- | --- | --- |
  | `rule` | "The weight has a unit in it" | a full clause, up to ~120 chars |
  | `advice?` | "Enter plain numbers only — the lb or kg choice on the form sets the unit for the whole file." | its own sentence, sometimes longer than the rule |
  | `rows` | `formatRows` → "row 15" / "5 rows: 2–4, 8, 11 and 3 more" | up to `MAX_ROW_RANGES_REPORTED` ranges |
  | `examples` | `"5 oz"`, `"12 lb"` | up to `MAX_EXAMPLE_VALUES` (3), each already quoted and cut at `MAX_QUOTED_CHARS` |

So the worst realistic payload is one paragraph plus twenty four-field records. That is a document,
and it decides everything below.

### What the payload implies for the layout

**Not a table.** A table is right for homogeneous short values that a reader scans by column.
These are two sentences of wildly varying length per row, and nobody sorts or compares them — each
one is read once and carried to a spreadsheet. Four columns of prose at 390px either wrap into
mush or force horizontal scroll on the one screen a user cannot afford to lose.

**A list of problem records, laid out as a locator plus a body.** The user's loop is *read where →
switch to Excel → fix → come back*, so the row span is the primary element, not a trailing detail:

```
5 rows: 2–4, 8, 11    The weight has a unit in it
                      Enter plain numbers only — the lb or kg choice on the form
                      sets the unit for the whole file.
                      "5 oz"  "12 lb"  "3 kg"
```

- `<ol>` of `<li>`, each `grid-cols-1` stacked on mobile and
  `sm:grid-cols-[minmax(8rem,14rem)_1fr]` above it, so the locators line up down the left edge on a
  wide screen and sit as a small bold line above their rule on a narrow one.
- The locator wraps rather than truncates — "5,000 rows: 2–4, 8, 11 and 3 more" is long, and it is
  the one thing that must stay readable.
- `advice` is muted secondary text; `examples` are a `flex flex-wrap` of monospace chips.
- **The examples already carry their own quotation marks** from `quote()`. Do not add more in
  markup, and never `{@html}` them — they are user cell values, including ones a spreadsheet would
  read as a formula (starting with `=`, `+`, `-` or `@`), quoted rather than executed by design.
- **The date-order problem renders above the list, in its own block**, labelled as covering the
  whole file. It is fatal and column-wide: fixing twenty row problems without fixing the date
  column is wasted work, so it cannot be item 21 in a list.
- A problem whose `rows.everyRow` is true gets a subtle emphasis. When one rule fails on every row,
  that rule *is* the file's problem.

### Where a rejection is shown: a view swap, not a page

A rejection is not an error on the form; it is a *finished verdict about the submission*, and
nothing else on the form is actionable until something changes. So while a rejection stands,
`upload-form.svelte` renders the rejection view in place of the form, full width, with one action
back: **Back to the form**. That is already how the code works — the reasoning above is recorded
here because it is what a redesign of the view must not undo, not because anything about it is
still to build.

**Client-side and server-side rejections render identically** — same component, same copy, same
action. `UploadRejection` is exactly the half of `RejectedUploadRecord` that both sides produce.
One line covers both origins without the component knowing which it has: *No report was created.*

## PR 1 — the rejection view

The design described in *What a rejection actually looks like* above. No behaviour changes, no new
props: the component's contract already shipped, so this PR is layout, hierarchy, and the tests
that hold them.

- The locator/body grid, stacked on mobile and two-column from `sm:` up, with the locator wrapping
  rather than truncating.
- The date-order block above the list, visually separated and labelled as covering the whole file.
- `advice` as secondary text; `examples` as monospace chips in a `flex flex-wrap`, with no added
  quotation marks and no `{@html}`.
- Emphasis on a problem whose `rows.everyRow` is true.
- Focus moved to the view's heading on mount (`tabindex="-1"`), no live region — per
  `README.md § Errors`, announcing a whole document on render is hostile.
- The **Back to the form** action given real prominence at both the top and the bottom of a long
  list, so a user who has read to the end does not scroll back up.

**Fixtures** — add a `rejectionWith(n)` helper to `csv/testing/` building an `UploadRejection` with
`MAX_PROBLEMS_REPORTED` problems, a date-order problem, and one `everyRow` problem, so the worst
case is what the tests and the screenshot render.

**Tests**

- `rejection-view.svelte.test.ts`: the summary is the heading and takes focus; a date-order problem
  renders above the first list item; every problem renders its rows, rule, advice and examples; an
  example is not double-quoted; a 20-problem rejection renders 20 items.
- **Responsive coverage goes to `layout.e2e.ts`, not the component test.** The repo already owns
  this: `expectNoHorizontalOverflow` names the offending element, and `VIEWPORT_WIDTHS` checks
  390/768/1280 rather than one hand-picked 375. Add a case that navigates to the form,
  `setInputFiles` a CSV with many bad rows, waits for the rejection view, and runs the same
  three-width sweep the route entry already runs for the empty form.

**Screenshot** — one new shot, `reports-new-rejection.png`, of the worst-case Shape B view. It
earns its place by the `e2e/README.md` standard (*capture routes that carry real visual risk*):
this is the densest layout in the app, its whole design is the grid, and a component test cannot
see it. Like the existing `reports-new.png` shot it needs no POST — `setInputFiles` a bad CSV and
`inspectFile` produces the rejection in the browser. It goes in `e2e/new-report/`, and the PNG stays
flat in `__screenshots__/` under its feature-prefixed name.

**Deliberately not captured:** Shape A and the rate-limit banner. Both are a single `Alert`
containing one sentence — near-zero visual risk, and the rate-limit one would need backdated
fixtures to reach `HOURLY_REPORT_LIMIT`. Assertions cover them. Every image is CI minutes and
repository bytes forever.

**Considered, not done:** a "Copy the list" button. `renderProblemsAsDetail` already produces
exactly that text, so it is cheap if a user asks for it — but it is a second way to read the same
thing, and nobody has asked.

## Follow-ups this work identifies but does not do

- **A Web Worker for normalization**, if the hand-measurement in *Verification* shows the main
  thread locked long enough to notice on a 10MB file.
- **XLSX in the browser**, per `ARCHITECTURE.md`. Widens `accept` and adds a spreadsheet library.
- **An empty-form screenshot**, once the form's visual design settles. Skipped now because the form
  is functional-first and this PR changes only the rejection view; a baseline captured mid-design is
  churn. `layout.e2e.ts` already guards the structural risk at three widths in the meantime.

## Verification

The test stack must be running: `TEST_DB=1 scripts/supabase start`.

1. Run `svelte-autofixer` (Svelte MCP) over `rejection-view.svelte` until it reports nothing.
2. From the repo root: `pnpm lint && pnpm check && pnpm test`.
3. After this PR's new shot: `pnpm turbo run screenshots:update --filter=@gbd/web`, then review the
   PNG diffs by eye before committing them.
4. `pnpm dev`, open `/` — seeded auth lands on the organization — then **New report**.
5. By hand:
   - Upload a CSV missing the weight column: a one-line Shape A rejection, not a list.
   - Upload a CSV with several kinds of bad row: the rejection view, focused, with the row spans
     down the left edge. Narrow the window to 390px and confirm nothing scrolls sideways.
   - Upload a CSV whose dates are written both ways: the date-order block above the list.
   - Rate limiting is exercised by `upload.test.ts` and `upload-form.svelte.test.ts`, not by hand —
     tripping `HOURLY_REPORT_LIMIT` for real means five successful uploads first. If it needs a
     manual look, lower `HOURLY_REPORT_LIMIT` locally rather than uploading five real files, and
     revert the change before committing.
6. Report which steps passed, and say plainly if any were skipped.
