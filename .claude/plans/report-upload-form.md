# New report upload form

## Context

[`reports/new/+page.svelte`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/new/+page.svelte)
is a stub, and it is the only thing left between a user and a report. Everything under it exists:

- `POST /api/orgs/[organizationId]/reports` accepts the upload, records a rejection, and answers
  201 with a `location` header, 400 with `userFacingRejection(...)` for a bad submission, or (added
  to `main` after this plan was first drafted) 429 with the same `userFacingRejection(...)` shape
  when [`lockAndCheckReportRateLimit`](apps/web/src/lib/server/reports/rate-limit.ts) finds the
  organization or user over `HOURLY_REPORT_LIMIT`/`WEEKLY_REPORT_LIMIT`. The client work below
  already accounts for this — see the rate-limiting notes under *Shape A*, the API client decision,
  and PR 2.
- [`metadata.ts`](apps/web/src/lib/reports/metadata.ts) names the fields and validates them;
  [`rejection.ts`](apps/web/src/lib/reports/rejection.ts) defines what a refusal looks like on the
  wire. [`monthsWithoutCounts`](apps/web/src/lib/reports/monthly-coverage.ts) refuses a submission
  whose counts miss a month the file has orders in.
- [`normalizeCsv`](apps/web/src/lib/reports/csv/normalize.ts) turns bytes into either the
  normalized CSV plus `months: MonthsFromFile` — the sorted, deduplicated, never-empty `YYYY-MM`
  months the file covers, a type alias declared in [`metadata.ts`](apps/web/src/lib/reports/metadata.ts)
  — or a `RejectedUploadRecord`. Every file in `csv/` is written to run in the browser as well as
  the server.
- [`inspect-file.ts`](apps/web/src/lib/reports/inspect-file.ts)'s `inspectFile(file: File):
  Promise<FileInspection>` is the browser's entry point: it runs the same size check, the same
  empty check, and the same `normalizeCsv` the server runs, discarding the normalized bytes (the
  server always redoes this from the original upload). `FileInspection` is `{ ok: true; months:
  MonthsFromFile } | { ok: false; rejection: RejectedUploadRecord }`. `describeUnreadableFile` in
  [`csv/describe/file.ts`](apps/web/src/lib/reports/csv/describe/file.ts) owns the copy for both
  new `UnreadableFile` kinds it produces, `too-large` and `empty`, and `submission.ts` calls the
  same function server-side so neither path hand-builds the sentence.
- The shadcn components are vendored — `input`, `label`, `field`, `radio-group`, `alert`,
  `separator`, `button` — along with the `file-drop-zone` (`Root` / `Trigger` / `Textarea`,
  `displaySize`, a `label` prop on the trigger) and its tests. `runed` and `svelte-toolbelt` are
  direct devDependencies.
- **The API layer is in place and unused by anything yet.** [`$lib/api/fetch.ts`](apps/web/src/lib/api/fetch.ts)
  is the one place a component may call `fetch`: `apiCall` returns the `Response` on 2xx, throws
  `ApiError` (`status`, a log-only `message`, and `jsonBody: JsonValue | undefined`) on a non-2xx,
  and `ApiUnreachableError` when no response ever arrived — including a request it aborts itself
  after `DEFAULT_TIMEOUT_MS` (20s). [`$lib/reports/rejection.ts`](apps/web/src/lib/reports/rejection.ts)
  is this feature's own client on top of it: `userFacingRejection` is what the server calls to turn
  a `RejectedUploadRecord` into the `UploadRejection` it sends, and `parseUploadRejection(error:
  ApiError)` is what a browser caller will call to turn a 400 back into the same shape, returning
  `undefined` for anything else. Nothing crossing the wire carries an enum a client would switch
  on — `summary` being a string is what tells a rejection body apart from any other 400.
- `apps/web/README.md` already documents calling the API from the browser — a component calls
  `$lib/api/fetch.ts`, never `fetch` itself, and a feature owns a parser that narrows `ApiError`
  into its own outcome. The remaining conventions this form establishes get recorded PR by PR,
  next to the code that establishes them — not as one dump.

This is the repo's first real frontend route, so the deliverable is two things: the form, and the
conventions the next ten routes copy.

**The browser runs the real normalizer.** `csv/` is free of `$env`, `$lib/server` and anything
Node-only, so the form derives the *exact* months the server will derive and the *exact* rejection
copy the server would send, before a byte is uploaded. `REQUIREMENTS.md § Errors` asks for errors
caught as early as feasible; this is as early as it gets. Two consequences run through the whole
design:

- **A rejected file is normally never uploaded at all.** A server 400 is the rare path — a stale
  tab, a non-browser client, a limit that moved. Both paths must produce the same screen, because
  what the user does next is identical.
- **The client's normalization is advisory.** The server redoes all of it and stores both the
  original and normalized bytes, so the browser uploads the *original* file, never its own
  normalization.

`months.length === 0` is unreachable on a successful normalization: a date that will not resolve is
a finding, and a finding is a rejection. The month component needs no empty state.

## What a rejection actually looks like

The rejection UI is the hardest part of this form, and it cannot be designed without knowing what
`csv/describe/` produces. There are two structurally different shapes.

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
[`rate-limit.ts`](apps/web/src/lib/server/reports/rate-limit.ts) (merged to `main` after this plan
was written — see `HOURLY_REPORT_LIMIT`/`WEEKLY_REPORT_LIMIT` in `limits.ts`) produces the same
`RejectedUploadRecord` shape as `describeUnreadableFile` — one `summary`, no `rowProblems` or
`dateOrderProblem` — so it renders through the exact same view with no new fields. Two things do
differ, and both matter to PR 2:

- **It answers 429, not 400.** `_createReport` returns `json(userFacingRejection(rejection), {
  status: 429 })` for a rate-limit rejection, and 400 for every other one. `parseUploadRejection`
  currently gates on `error.status !== 400`; it has to accept 429 too, or a rate-limited upload
  falls through to the `unknown` outcome and loses a summary that already tells the user what to
  do.
- **It is never client-side.** Every other Shape A reason can be caught by `inspectFile` before a
  byte is sent; the rate limit lives in the database, so this one is always a server rejection —
  `inspectFile` has nothing to check locally, and there is no "advisory" version of it the way
  there is for size and emptiness.
- **The fix is not the file.** "Choose a different file" is the right instruction for every other
  Shape A reason and is actively wrong here — the file may be perfect, and the copy already says
  "Try again in a little while" / "Try again next week". See the action rename below.

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
  | `rows` | `formatRows` → "row 15" / "5 rows: 2–4, 8, 11 and 3 more" / "all 4,500 rows" | up to `MAX_ROW_RANGES_REPORTED` ranges |
  | `examples` | `"5 oz"`, `"12 lb"` | up to 3, each already quoted and cut at 40 chars |

So the worst realistic payload is one paragraph plus twenty four-field records. That is a document,
and it decides everything below.

### What the payload implies for the layout

**Not a table.** A table is right for homogeneous short values that a reader scans by column.
These are two sentences of wildly varying length per row, and nobody sorts or compares them — each
one is read once and carried to a spreadsheet. Four columns of prose at 375px either wrap into
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

**The view writes no sentences about the user's file.** Every such sentence lives in `describe/`,
per that folder's contract. If the screen wants copy that is not in the payload — for instance a
line for "every row failed, so a column is probably mapped to the wrong data" — it is added to
`describe/findings.ts` and reaches the UI as part of the payload. This is the rule that keeps the
browser and the server saying the same thing, and it is why the component takes
`UploadRejection` and renders it, rather than switching on `reason`.

### Where a rejection is shown: a view swap, not a page

A rejection is not an error on the form; it is a *finished verdict about the submission*, and
nothing else on the form is actionable until something changes. So while a rejection stands,
`upload-form.svelte` renders the rejection view in place of the form, full width, with one action
back: **Back to the form**.

That label, not "Choose a different file", is deliberate: it is the accurate description of what
the button does — remount the form with every typed value intact — for every reason, including
rate limiting, where the file was never the problem. A component that never switches on `reason`
(the rule below) needs a label that is true regardless of which reason produced the rejection; a
file-specific label was only ever true for the CSV reasons this plan started with.

It is a view, not a route, and the reason is precise: in the common case the rejection was produced
in the browser and nothing was ever sent, so there is no server state a URL could address and
nothing a refresh could reload. Adding `?rejected` would promise durability the data does not have.

**Client-side and server-side rejections render identically** — same component, same copy, same
action. The user's next move is the same in both cases, and `UploadRejection` is exactly the
half of `RejectedUploadRecord` that both sides produce. One line covers both origins without the
component knowing which it has: *No report was created.*

**Trap: the swap must not eat typed work.** `{#if}` destroys the form's markup, so any value living
only in a DOM node is lost — a user who fixes their CSV would have to retype the report name and
twelve months of counts. Every field's value therefore lives in `upload-form.svelte`'s own `$state`
(and `counts` is `$bindable` down into the month component), so unmounting the markup loses
nothing and remounting restores it. Using `hidden` instead is worse: the controls stay in the DOM,
`new FormData(form)` still picks them up, and a `required` hidden control reintroduces the
not-focusable trap below.

`cfa-web-app`'s `auth-flow.svelte` is the same shape: the stages swap each other out while `email`
is held by the parent and passed down with `bind:`.

## Decisions

### The API client stays generic; each feature owns its own outcome union

`ApiError` must not grow a field for every payload a route invents, and this endpoint's 400 body
does not fit the generic shape anyway: it has no `message` and no `problems`, it has `summary`,
`rowProblems` and `dateOrderProblem`. Three layers, each knowing only what is true at its level:

| Layer | Knows | Example |
| --- | --- | --- |
| `$lib/api/fetch.ts` | HTTP. A status, a message for a log, and the parsed JSON body, if any. | `apiCall`, `ApiError`, `ApiUnreachableError` |
| A feature's client | Which statuses this endpoint means, and what its bodies are. | `parseUploadRejection` in `$lib/reports/rejection.ts` |
| The component | An outcome union with no HTTP in it. | `upload-form.svelte` |

`ApiError` is `{ status, message, jsonBody: JsonValue | undefined }` — `message` only for a log or
a last-resort string, `jsonBody` for the layer that knows the shape. `parseUploadRejection` is the
only thing that knows a 400 *or 429* from this endpoint is an `UploadRejection`; `uploadReport`
(PR 2) is its only caller:

```ts
export type UploadOutcome =
  | { kind: 'created'; location: string }
  | { kind: 'rejected'; rejection: UploadRejection }
  | { kind: 'unknown' };
```

This applies the README's existing server-side rule — *an outcome the caller expects is returned,
not thrown* — to the browser side: `apiCall` throws because at the HTTP layer every non-2xx is
exceptional, and `uploadReport` catches because at the feature layer a 400 or 429 is an expected
answer.

**`parseUploadRejection` needs updating, not replacing.** It already exists (report rate limiting
landed on `main` after this plan was drafted, ahead of the client) and currently reads
`if (error.status !== 400) return undefined;`. Change the guard to accept 400 or 429 — everything
below it already works unchanged, because `describeRateLimitExceeded` produces the same
`RejectedUploadRecord` shape `userFacingRejection` was already narrowing. No new branch in the
component, no new field in `UploadRejection`: this is the "new failure mode" pattern the CSV side
already established with `too-large`/`empty` in `describeUnreadableFile` — the new case is a fact
about which status codes carry a rejection, decided in one function, not a switch that spreads
through callers.

**Accepted:** `unknown` also swallows a 401/403/404, which are definite rather than unknown. The
page's `load` already guarded access, so reaching one means the session died mid-form, and "we do
not know whether that was received — check your reports" is still safe advice. Not worth a fourth
branch until something can produce one. A 429 from something other than our own rate limiter (a
proxy, a CDN) is not a case that exists in this stack today; if one appears, `parseUploadRejection`
returning `undefined` for a body without a `summary` string already falls it through to `unknown`
correctly, so no extra guard is needed ahead of that happening.

### Three failure surfaces, deliberately not one

"The form is not ready to send", "your file will not do", and "we do not know what happened" are
three different things asking for three different actions. They never share a widget.

| Surface | Cause | What the user does | Where it appears |
| --- | --- | --- | --- |
| **Field** | a required field is empty, no file chosen, no unit system | fill it in | the browser's own message on the field, or an inline `Field.Error`; `role="alert"` for the two hand-written ones |
| **Rejection** | the CSV itself (client-side or server-side), or the org/user rate limit (always server-side) | leave the app, address it — fix the file or wait — come back | the rejection view, in place of the form |
| **Unknown outcome** | `fetch` rejected, or a 5xx | check the report list | a short `role="alert"` panel at the submit button, with no retry, per `REQUIREMENTS.md § Errors` |

**Announcement differs with size.** A short message gets `role="alert"` and is read out. The
rejection view must **not** be a live region — announcing twenty problems on render is hostile.
Move focus to its heading (`tabindex="-1"`, `.focus()`) and let the user read at their own pace.
The "Checking your file…" state gets a polite `aria-live` region, not an alert.

### No toast, and the reason is not the dependency

A toast is timed, sits far from what it describes, and is gone by the time the user has switched to
Excel. Every message here is either attached to a field or long enough that it has to stay on
screen while the file is repaired.

A toast is still the right tool — for a *transient confirmation of an action on a page that stays
put*. That is exactly how `cfa-web-app` uses `svelte-sonner`: "Your public profile is live again",
"Failed to log out". Nothing on this form is that shape, and success navigates away, so there is
nothing to confirm in place. Record the convention with that reasoning, so a later page that
genuinely needs a toast is not blocked by a rule about dependencies.

### The submit button stays enabled, and is disabled only in flight

Two different things get confused under "disabled submit":

- **Disabled until valid** — rejected. It tells the user nothing about *why*, gives them nothing to
  click to find out, and turns a form into a puzzle. Keeping it enabled and letting the browser
  refuse the submit is strictly more informative: the browser focuses the first field that needs
  work, scrolls to it, and says what is wrong.
- **Disabled while a request is in flight** — kept, with the label changing to "Uploading…" and
  `aria-busy`. The reason is on screen, and it stops a double POST creating two reports. Guard on
  the state variable inside the handler too, not only the attribute — Enter in a text field submits
  a form without touching the button.

### The form follows `cfa-web-app`, minus the disabled gate

`cfa-web-app` has a settled pattern across four forms
(`create-event/+page.svelte`, `profile-form.svelte`, `email-form.svelte`, `onboard-form.svelte`).
Take it:

- `<form bind:this={formElement} onsubmit={handleSubmit}>`, and `event.preventDefault()` first
  thing in the handler.
- Constraint attributes on the inputs — `required`, `maxlength`, `type`, `min`/`step` — as the only
  source of truth for what a valid field is. No schema mirrored in the browser.
- `new FormData(event.currentTarget as HTMLFormElement)`, then `set`/`append` for what is not a
  form control (`create-event` appends its cropped image; we set the file and the serialized
  counts).
- A state union driving the submit button's label — "Submitting…" / "Submitted" — and the button
  disabled while `loading` **and** while `success`, since a navigation is still pending and a
  second click would fire a second POST.
- `<Field.Error>` for anything the browser did not say itself: async failures and our own checks.
- `goto` from the response's `Location` header — `create-event/+page.svelte` does exactly this
  after `POST /api/event`.

**One divergence: the submit button is not disabled for an invalid form.** cfa gates it with

```svelte
let formInteracted = $state(0);
let isFormValid = $derived.by(() => { formInteracted; return formElement ? formElement.checkValidity() : false; });
<form oninput={() => formInteracted++} …>
```

The mechanism is sound — bumping a counter on `oninput` catches every field, including month inputs
that appear after a file is chosen — so this is not a reservation about the technique. It is about
this form. cfa's largest gated form has nine fields; this one has up to **120 required month
inputs**, and a greyed-out button is the least informative possible answer to "which of my 120
fields is empty". Submitting instead makes the browser scroll to the first empty month and say
"Please fill out this field" — a locator, which is what the user needs. The month fieldset's "3 of
12 months still need a count" line is the standing, always-visible version of the same answer.

Two smaller reasons follow from that:

- `checkValidity()` cannot see the file or the unit system, for the trap reasons below, so a gate
  would have to be `isFormValid && !!file && !!unitSystem` to avoid lying — at which point we are
  hand-maintaining the definition of "ready" anyway.
- A button that is grey from first paint until the last of 120 fields is filled spends nearly the
  whole session looking broken.

If this ends up feeling inconsistent with the rest of the codebase, the fix is to settle it
repo-wide rather than special-case this form.

**Two traps make native validation silent**, and both need a hand-written check plus a
`<Field.Error>`:

- **The drop zone's file input is `class="hidden"`.** Marking it `required` makes the browser refuse
  to submit with `An invalid form control is not focusable` on the console and *no* visible message.
  Leave it un-`required` and check `if (!file)` in the handler.
- **`RadioGroup` submits through a hidden input**, and hidden inputs are barred from constraint
  validation, so `required` on it is a no-op rather than an error.

For the two radio groups that check is avoided where it is safe to:

- **`counts-basis` defaults to `people`.** The consequence is visible one line below, in the month
  fieldset's legend ("Diners per month" / "Meals per month"), so a wrong default cannot go unread.
- **`unit-system` has no default** and is checked in the handler with an inline error. lb versus kg
  is a silent 2.2× error in the analysis with nothing on screen to contradict it, and a default is
  exactly what gets accepted without being read.

**Not taken: cfa's shared `ActionState`.** `{ status: 'error'; message: string }` cannot hold a
rejection — that is a document, not a message — and `success` is not a state here because the page
navigates away. Each form declaring its own union is the same conclusion cfa reached for
`create-event`, which carries a `croppedImageFile` and a `Location` alongside its `ActionState`.

### The browser and the server say the same thing about a file

`inspectFile` runs the same size check, the same empty check, and the same `normalizeCsv` the
server runs. The copy for the first two currently sits inline in
[`submission.ts`](apps/web/src/lib/reports/submission.ts), which would put two copies of a
user-facing sentence in the tree. Move them into
[`csv/describe/file.ts`](apps/web/src/lib/reports/csv/describe/file.ts), which already owns *every
sentence a customer reading a rejection sees* and already returns `reason: 'too_large'` for
`too-many-rows` and `reason: 'empty'` for `no-data-rows`. Two new `UnreadableFile` kinds,
`too-large` and `empty`, and both callers ask `describeUnreadableFile` for the words.

**The server keeps its current order** — size, bytes, empty, metadata, `normalizeCsv`, month
coverage. Do not hoist normalization above the metadata parse to share a bigger function: cheap
validation belongs before the expensive parse, or a request with junk metadata still costs a
500,000-row parse.

**Normalization blocks the main thread.** A 10MB CSV is a real parse, and the "Checking your file…"
state cannot animate while it runs. Accepted for now: yield once (`await new Promise(setTimeout)`)
so that state paints before the thread locks, and measure it by hand on a large file. A Web Worker
is the fallback if it feels bad — its own change, and nothing here has to move for it.

**Upload progress is not available.** `fetch` cannot report it; that needs XHR or request streams. A
spinner without a percentage is the honest option. Out of scope, as is cancelling an upload.

### The form's shape

Order is progressive disclosure, because the months cannot exist before the file does:

1. **The file** — what the file should look like (the three columns, CSV, the size limit), then the
   drop zone, then the chosen-file summary with Replace.
2. **Report details** — name, optional site name, counts basis, unit system.
3. **Monthly counts** — before a file is accepted, the section renders a muted "Choose a file first
   — we will list the months it covers", so the section is not a hole that appears later.

`counts-basis` sits above the month fieldset because it decides the legend the user reads there.

**Drop-zone rejections get our copy, not the component's.** `FileRejectedReason` is
`'Maximum file size exceeded' | 'File type not allowed' | 'Maximum files uploaded'`. A user who
drags an `.xlsx` deserves "We can only read CSV files right now. In Excel, choose File → Save As →
CSV" rather than "File type not allowed" — the `.xlsx` never reaches `decodeCsv`, which has that
sentence, because `accept` filtered it first. One small `fileRejectionMessage(reason)` maps the
three.

**XLSX is out of scope.** `REQUIREMENTS.md` wants it and `ARCHITECTURE.md` puts the conversion in
the browser; it needs a spreadsheet library and care with Excel serial dates. Its own PR, and
`accept` widens then.

## Recording conventions in `apps/web/README.md`

Load the `writing-docs` skill before touching the README in any of the PRs below. Each PR adds
only the convention it establishes, in the section named for what a reader is looking up —
`## Routes`, `## Forms`, `## Errors`, `## UI components` — never a new `## Frontend` catch-all.
Splitting them this way, rather than writing the whole set in one PR, means each convention gets
reviewed — and can be adjusted — in the PR that actually puts it into practice, instead of being
approved in the abstract ahead of the code.

## PR 1 — the month-count model and its component

**`src/lib/reports/monthly-counts.ts`** — pure, node-tested:

- `type CountDraft = Record<string, number | undefined>` — `undefined` because `bind:value` on
  `<input type="number">` yields `undefined` for an empty or unparseable field.
- `reconcileDraft(previous, months)` — keeps values for months still present, drops the rest, leaves
  new months empty, so replacing a file does not discard typed work.
- `serializeCounts(draft, months)` — the JSON the `monthly-counts` field carries, or `null` when a
  month is missing. Must satisfy `MonthlyCountsSchema`.
- `formatMonth('2026-01') → 'January 2026'` — `Intl.DateTimeFormat('en-US', { month: 'long', year:
  'numeric', timeZone: 'UTC' })`, built once at module scope, matching `monthly-coverage.ts` and
  `packages/email/src/messages/invite.ts`. The `Intl` ban is scoped to `csv/describe/` and does not
  reach here. Parse the key as `Date.UTC(year, month - 1, 1)`, never `new Date(string)`.
- `groupByYear(months)` and `missingMonthCount(draft, months)`.

**`.../reports/new/monthly-counts.svelte`** — in its final home; PR 2 is wiring only.

- Props: `months: MonthsFromFile`, `basis: CountsBasis`, `counts = $bindable<CountDraft>()`.
- A `<fieldset>` whose `<legend>` follows `basis` — "Diners per month" / "Meals per month" — and a
  description line reading `"{n} of {total} months still need a count"`, the standing answer to "why
  did submit not go through". A hint, not an error: it does not turn red and blocks nothing.
- A row per month: label from `formatMonth`, then
  `<input type="number" min="0" step="1" inputmode="numeric" required bind:value={counts[month]}>`.
  One column up to six months, `sm:grid-cols-2` beyond, with a year subheading when the span crosses
  years. `MAX_MONTHS` is 120, so the grid and the shortcut below both have to survive a decade.
- **"Use the same count for every month"** — one input plus Apply, writing into every month. The main
  time-saver past a year of data.
- No empty state: `months` is only ever non-empty, and the form renders the "no file yet"
  placeholder itself.

**Tests** — `monthly-counts.test.ts` (node) for the pure functions;
`monthly-counts.svelte.test.ts` for a labelled row per month, Apply filling every row, the legend
following the basis, the progress line counting down, and inputs being `required`.

**README** — `## UI components`: a route-local component lives beside its route and is promoted to
`src/lib/components/<feature>/` only when a second route needs it; `ui/` stays purely vendored.
`monthly-counts.svelte` is the first route-local component in the app, so this is where the
convention is worth writing down rather than assumed.

## PR 2 — the route

**`src/lib/reports/upload.ts`** — the feature client:

```ts
export async function uploadReport(
  organizationId: string,
  form: FormData,
  signal?: AbortSignal,
): Promise<UploadOutcome>;
```

201 → `{ kind: 'created', location }` from the response header, falling back to
`/orgs/{organizationId}` if it is absent. cfa throws there; a 201 means the report *was* created, so
landing the user on the org page beats an error about a header they cannot act on. An `ApiError`
with status 400 *or 429* whose `parseUploadRejection(error)` returns a value → `{ kind: 'rejected'
}` — `_createReport` answers 429 for a rate-limit rejection and 400 for every other one, and
`uploadReport` does not need to know which. Everything else, including `ApiUnreachableError`, a
5xx, and a 400/429 that is not a rejection → `{ kind: 'unknown' }`.

**`.../reports/new/upload-form.svelte`** — prop `organizationId`. State:
`idle | checking | submitting | rejected(UploadRejection) | unknown`. Success is not a state; the
page navigates away. Every field's value is `$state` on this component, per the trap above.

- Drop zone: `maxFiles={1}`, `accept=".csv,text/csv"`, `maxFileSize={MAX_UPLOAD_BYTES}`, trigger label
  and hint copy from `MAX_UPLOAD_MEGABYTES` ([`limits.ts`](apps/web/src/lib/reports/limits.ts)).
  `onUpload` keeps `files[0]`, enters `checking`, runs `inspectFile`, and either sets `months` and
  runs `reconcileDraft` or moves to `rejected` and clears the file. `onFileRejected` renders
  `fileRejectionMessage(reason)` inline under the zone.
- Chosen-file summary: name, `displaySize(file.size)`, Replace.
- `Field` + `Input` for `report-name` (required) and `site-name` (optional), both
  `maxlength={MAX_FREE_TEXT_LENGTH}`.
- `RadioGroup` for `counts-basis` (default `people`) and `unit-system` (no default), each with `name`
  from `FIELD` so it reaches `FormData`.
- `<MonthlyCounts bind:counts {months} basis={countsBasis} />` once a file is accepted, the
  placeholder otherwise.
- Submit handler, following `cfa-web-app`'s `create-event/+page.svelte`: `event.preventDefault()`;
  bail if already submitting; check the file and the unit system and render their `<Field.Error>`s;
  build `new FormData(event.currentTarget as HTMLFormElement)`, then `set(FIELD.file, file)` and
  `set(FIELD.monthlyCounts, serialized)`; bail if `serializeCounts` returned `null`. Then
  `uploadReport`. `created` → `goto`. `rejected` → the rejection view. `unknown` → the short panel at
  the submit button, linking to `/orgs/{organizationId}` and offering no retry.
- The button is disabled while `submitting` **and** after `created`, since the `goto` is still in
  flight. Its label follows the state.

**`.../reports/new/rejection-view.svelte`** — created here, **plain**: the summary as a heading, the
date-order problem as its own paragraph, an `<ol>` of problems each rendering
`formatRows(problem.rows)`, `rule`, `advice`, and `examples` as running text, the "No report was
created" line, and the **Back to the form** button. Correct and usable; PR 3 designs it.
Props are `UploadRejection` plus the action — it never switches on `reason` and never writes a
sentence about the file, which is exactly why a rate-limit rejection (all summary, no
`rowProblems`/`dateOrderProblem`) needs no special case here: it renders through the same one-line
Shape A path as `too_large` or `empty` already do.

**`.../reports/new/+page.svelte`** — heading, keep the sentence naming the organization
(`REQUIREMENTS.md § Users and organizations` requires it), render
`<UploadForm organizationId={data.organization.id} />`, drop the stub comment. `+page.server.ts`
keeps its stub: the upload-allowance load is a separate change.

**Tests**
- `upload.test.ts` (node, stubbed `fetch`): 201 yields the location; a 400 rejection body yields
  `rejected` with its summary and problems; **a 429 rejection body (rate limiting) also yields
  `rejected`, with only its summary** — the regression test for the status-code guard; a 400 that
  is not a rejection yields `unknown`; a rejecting `fetch` yields `unknown`.
- `upload-form.svelte.test.ts` (browser, stubbed `fetch`): every field posts under its `FIELD` name;
  a 400 shows the rejection view; **returning from the rejection view restores the typed name and
  the month counts** — the regression test for the state trap; **a 429 shows the same rejection
  view, with the "Back to the form" label rather than file-specific copy**; a rejecting `fetch`
  renders the unknown-outcome message and the report-list link; submitting with no file posts
  nothing and shows the inline message; submitting with no unit system posts nothing.
- `apps/web/e2e/new-report.e2e.ts`: navigate from the org page, `setInputFiles` a fixture CSV, fill
  the months, submit, land on the report page. A second case uploads a CSV with bad rows and asserts
  the rejection view names them.

**README** — `## Forms`, expanded with this PR's conventions:
- Native constraint validation, no form library, consistent with `ARCHITECTURE.md` rejecting form
  actions. A real `<form>` with `onsubmit` and a `<button type="submit">` mean the browser blocks an
  invalid submit and focuses the first bad field; `reportValidity()` is only for a programmatic
  submit. Async failures and hand-written checks render in a `<Field.Error>`.
- **Trap:** a hidden or `type="hidden"` control is skipped by constraint validation. `required` on
  a hidden file input blocks submission with no visible message; on a `RadioGroup`'s hidden input it
  does nothing at all. Those get a check in the handler and an inline message.
- The submit button stays enabled for an invalid form, and is disabled only while a request is in
  flight or a navigation is pending, with the reason in its label. A disabled button cannot say
  which field it is waiting on; the browser's own refusal can.
- A field name always comes from a `FIELD` map, never a literal in markup.
- Each form declares its own outcome union.
- **A form's values live in the component's state, not only in the DOM**, so a form that swaps its
  own view cannot lose typed work.

And `## Errors`, with a "what the user sees" half added:
- Three surfaces, never merged: a field problem at the field, a rejected file in its own view, an
  unknown outcome at the action that caused it.
- A short message gets `role="alert"`. A long one does not — announcing a whole document on render
  is hostile; move focus to its heading instead.
- A failure inside a form is shown inline and stays until it is fixed. A toast is for a transient
  confirmation of an action on a page that stays put; no page needs one yet, and adding one is a
  fine reason to add the dependency then.
- One component renders both a client-side and a server-side rejection: both narrow to
  `UploadRejection` (`summary`, `rowProblems?`, `dateOrderProblem?`) in
  `src/lib/reports/rejection.ts`.

## PR 3 — the rejection view

The design described in *What a rejection actually looks like*. No behaviour changes, no new props:
the component's contract is already fixed by PR 2, so this PR is layout, hierarchy, and the tests
that hold them.

- The locator/body grid, stacked on mobile and two-column from `sm:` up, with the locator wrapping
  rather than truncating.
- The date-order block above the list, visually separated and labelled as covering the whole file.
- `advice` as secondary text; `examples` as monospace chips in a `flex flex-wrap`, with no added
  quotation marks and no `{@html}`.
- Emphasis on a problem whose `rows.everyRow` is true.
- Focus moved to the view's heading on mount (`tabindex="-1"`), no live region.
- The **Back to the form** action given real prominence at both the top and the bottom of a long
  list, so a user who has read to the end does not scroll back up.

**Fixtures** — add a `rejectionWith(n)` helper to `csv/testing/` building a `UploadRejection`
with `MAX_PROBLEMS_REPORTED` problems, a date-order problem, and one `everyRow` problem, so the
worst case is what the tests render.

**Tests** — `rejection-view.svelte.test.ts`: the summary is the heading and takes focus; a
date-order problem renders above the first list item; every problem renders its rows, rule, advice
and examples; an example is not double-quoted; a 20-problem rejection renders 20 items; at
`page.viewport(375, 667)` the view does not scroll horizontally
(`document.documentElement.scrollWidth <= clientWidth`) — `@vitest/browser` 4.1.10 has `page.viewport`.

**Considered, not done:** a "Copy the list" button. `renderProblemsAsDetail` already produces exactly
that text, so it is cheap if a user asks for it — but it is a second way to read the same thing, and
nobody has asked.

## Verification

The test stack must be running: `TEST_DB=1 scripts/supabase start`.

1. Run `svelte-autofixer` (Svelte MCP) over every new `.svelte` file until it reports nothing.
2. From the repo root: `pnpm lint && pnpm check && pnpm test`.
3. `pnpm dev`, open `/` — seeded auth lands on the organization — then **New report**.
4. By hand:
   - Tab through the whole form keyboard-only, including the drop zone and the radio groups.
   - Submit empty: the browser focuses the report name. Then with a name but no file: the inline file
     message. Then with no unit system: its inline message.
   - Drop a `.txt` and an `.xlsx`: our CSV copy, not "File type not allowed". Drop a file over 10MB:
     our size copy.
   - Upload a CSV missing the weight column: a one-line Shape A rejection, not a list.
   - Upload a CSV with several kinds of bad row: the rejection view, focused, with the row spans
     down the left edge. Narrow the window to 375px and confirm nothing scrolls sideways.
   - Upload a CSV whose dates are written both ways: the date-order block above the list.
   - **Back to the form** and confirm the report name and any month counts are still there.
   - Upload a good CSV spanning two years: a labelled input per month under year subheadings, the
     progress line counting down, and Apply filling every month. Submit and land on the report page.
   - **Measure the block:** upload a CSV near 10MB and note how long the UI is unresponsive during
     "Checking your file…". Report the number — it decides whether the Web Worker follow-up is needed.
   - Rate limiting is exercised by `upload.test.ts` and `upload-form.svelte.test.ts`, not by hand —
     tripping `HOURLY_REPORT_LIMIT` for real means five successful uploads first. If it needs a
     manual look, lower `HOURLY_REPORT_LIMIT` locally rather than uploading five real files, and
     revert the change before committing.
5. Report which steps passed, and say plainly if any were skipped.
