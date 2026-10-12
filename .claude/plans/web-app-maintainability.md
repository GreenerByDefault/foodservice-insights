# Web app maintainability

## Context

The frontend is feature-complete bar the CSP. A review on 2026-10-11 of `apps/web` for long-term
maintainability — can a future developer or agent extend it without being misled — surveyed code
organization and DRY, Tailwind usage, and every doc that describes the TypeScript stack, then
checked each finding against the files. Correctness was out of scope and is believed good.

The code is in good shape. Every write route follows the `_`-prefixed convention — each `_`
function wraps its own DB calls and returns the `Response` — every vendored shadcn component is in
use, no route imports across another route, `hrefs.ts` is used everywhere it should be, and the
test tiers are named consistently. What surfaced is a few conventions the code follows in two
ways, and class strings that had already drifted between copies. The docs that had drifted
from the code have been rewritten to match it.

The page shell now comes from one place: the `page-width` utility in `src/routes/layout.css` is the
column every header, `<main>` and marketing section sits in, `lib/components/site-header.svelte` is
the one header bar (`public-header.svelte` and the `(app)` layout fill it through `children`), and
`page-heading.svelte` takes an optional `actions` snippet for the title-plus-button row, stacking
on mobile. A shape component in `lib/components/` takes its variable parts as snippets like these,
not a `class` prop.

What remains is one optional PR. It changes no behaviour.

Facts marked **verified** were checked against the file on 2026-10-11.

## Decisions

- *Accepted: where the code does one thing two ways, pick the way the rule file already names.*
  `.claude/rules/typescript.md` says the `_` function wraps its own DB calls and returns what the
  handler sends; the plan moves the stragglers to that, rather than relitigating the rule.
- *Accepted: styling is DRYed only where two copies have already disagreed, or sit on one screen.*
  The page shell qualified and is done; the members-page rows (PR 1) are the last. The rest —
  `space-y-4` vs `space-y-6` across report views, three `<h2>` styles each local to one view, ten
  inline `<p role="alert" class="text-sm text-destructive">`, twenty `text-sm
  text-muted-foreground` — are short Tailwind phrases, not page shapes, and are left alone.
- *Considered, not done: wiring or removing dark mode.* Nothing in `src/` ever sets the `.dark`
  class (**verified**), so `layout.css`'s `.dark` block and every `dark:` variant are dead. The
  block and the variants in `ui/` are vendored shadcn and stay; there is no hand-written `dark:`
  left. Turning dark mode on is a feature, not cleanup.
- *Considered, not done: deduplicating failure copy between server and client.* The last-admin,
  name-taken, slug-*, already-member, and rate-limited messages are each written once in a
  `+server.ts` or `lib/server/orgs/*.ts` and again in the form that renders the outcome.
  `apps/web/README.md` § Errors says the server's message is for JSON readers, not the screen, so
  the two are allowed to differ. Leave.
- *Considered, not done: splitting `lib/reports/limits.ts`.* It holds upload caps, CSV and
  workbook parser caps, report rate limits, and waiting-screen timings — four audiences in one
  file, changed eleven times in the last 200 web commits. But every constant carries its own
  reasoning, `csv/` and `excel/` import the parser caps throughout, and two root docs link to it.
  Revisit if it keeps churning.
- *Considered, not done: `_loadAllOrganizations` is a pass-through to `listOrganizations`, and
  `OrganizationListRow` / `SwitcherOrganization` alias `OrganizationRow`.* They give each page its
  own tested `_` function and its own type for the view to import, which is the convention. Keep.
- *Considered, not done: `requireOrganizationRouteContext` returning the user.* Three handlers call
  `requireAuth` a second time for the email or display name. Returning the user would change every
  `*RouteContext` signature for a small win. Leave.
- *Considered, not done: Biome's `useImportExtensions`.* It would make the `.ts` convention
  executable but flags `./$types`. The two hand-written extensionless imports have been fixed by hand.
- *Considered, not done: the shadcn CLI's `@internationalized/date` devDependency.* No file imports
  it (**verified**); `bits-ui` depends on it transitively. The CLI manages it; leave.
- *Deferred to the a11y pass:* `failure/failure-view.svelte`'s Retry button lacks the `aria-busy`
  every other loading button sets. *Deferred until the form is next touched:*
  `account/change-email-form.svelte` has no `FIELD` map, unlike every other form.

## PR 1 — Two list rows on one screen share a row

Optional. `members-list.svelte:31,35` and `pending-invite-row.svelte:41,43` carry identical class
strings for the `<li>` (`flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-2 py-3`) and the
stacking name/role block (`flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center
sm:justify-between sm:gap-4`), kept in step by comments that point at each other. They render one
above the other on the members page, so any difference shows at once.

A `lib/components/item-list-row.svelte` beside `item-list-link.svelte`: the `<li>`, the stacking
block around `children`, and an optional `actions` snippet after it for the menu, the Revoke button,
or the `basis-full` error line. The two rows' cross-referencing comments become the component's
header. `item-list-link.svelte` keeps its own `<a>`, which has hover state these don't.

No screenshot may change.

## Verification

From the repo root: `pnpm lint && pnpm check && pnpm test`, in the background once the change is
ready. While iterating, run only the file under change
(`pnpm --filter @gbd/web test:unit -- path/to/thing.test.ts`).

`pnpm test` includes the screenshot suite, and no screen may differ. A diff is a bug in the
refactor, not a baseline to update.

After the PR lands, `/plan-advance .claude/plans/web-app-maintainability.md` deletes the plan.
