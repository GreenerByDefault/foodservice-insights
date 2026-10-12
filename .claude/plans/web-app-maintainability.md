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
ways, and three class strings that have already drifted between copies. The docs that had drifted
from the code have been rewritten to match it.

Each PR below is independent and ordered by cost, cheapest first. None changes behaviour; PR 1
resolves two visual drifts, and says which side wins. Stop wherever the returns run out — the
later PRs are the ones most reasonable to skip.

Facts marked **verified** were checked against the file on 2026-10-11.

## Decisions

- *Accepted: where the code does one thing two ways, pick the way the rule file already names.*
  `.claude/rules/typescript.md` says the `_` function wraps its own DB calls and returns what the
  handler sends; the plan moves the stragglers to that, rather than relitigating the rule.
- *Accepted: styling is DRYed only where two copies have already disagreed, or sit on one screen.*
  Three cases qualify (PR 1, PR 2). The rest — `space-y-4` vs `space-y-6` across report views,
  three `<h2>` styles each local to one view, ten inline `<p role="alert" class="text-sm
  text-destructive">`, twenty `text-sm text-muted-foreground` — are short Tailwind phrases, not
  page shapes, and are left alone.
- *Considered, not done: wiring or removing dark mode.* Nothing in `src/` ever sets the `.dark`
  class (**verified**), so `layout.css`'s `.dark` block and every `dark:` variant are dead. The
  block and the variants in `ui/` are vendored shadcn and stay; the one hand-written `dark:` goes
  (PR 1). Turning dark mode on is a feature, not cleanup.
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

## PR 1 — The page shell comes from one place

`apps/web/README.md` § UI components: "A page's shape comes from a component, not a class string
copied between pages." The app shell is where that is not yet true (**verified** throughout):

- **`mx-auto w-full max-w-4xl px-6 sm:px-8`** is copied seven times: `(app)/+layout.svelte` header
  and main, `public-header.svelte`, `public-shell.svelte`, and three sections of the marketing
  page `routes/+page.svelte`. The header and content only line up because the strings match.
  Define it once in `src/routes/layout.css` as `@utility page-width { @apply mx-auto w-full
  max-w-4xl px-6 sm:px-8; }` and use the class in all seven. (A `<PageWidth class>` component is
  the alternative; the utility needs no `class`-prop-plus-`cn` pattern, which only one component
  has today.)
- **The two header bars have drifted.** `public-header.svelte:17` holds `min-h-15` so the bar
  doesn't shrink between the marketing page and sign-in; `(app)/+layout.svelte:19` doesn't. One
  `lib/components/site-header.svelte` owning `<header class="border-b">` and the
  `page-width flex min-h-15 items-center gap-3 py-3` bar, with a `children` snippet for what sits
  in it. `public-header.svelte` and the app layout both build on it.
- **The page-title-plus-button row has drifted.** `orgs/+page.svelte:15` stacks on mobile
  (`flex-col … sm:flex-row`); `orgs/[organizationSlug=slug]/+page.svelte:15` never does, and the
  next list page will copy one of them. Give `page-heading.svelte` an optional `actions` snippet
  that renders the stacking row; both pages use it. The reports page gains the stacking —
  stacking wins, since a long heading beside a button overflows otherwise.
- **`account/+page.svelte:30` uses `gap-8`, `settings/+page.svelte:18` `gap-4`** for the same
  form-separator-danger-zone column. Pick one (`gap-8` reads better with the separator).
- **`waiting/timeline.svelte:43` `dark:text-amber-500`** never applies (see Decisions). Drop it.

Expected screenshot diffs: the reports page at the mobile viewport, the settings page, and
possibly the app header's height if `min-h-15` is taller than its buttons made it. Every other
screen must be pixel-identical — that is the proof the refactor changed nothing else.

## PR 2 — Two list rows on one screen share a row

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

Per PR, from the repo root: `pnpm lint && pnpm check && pnpm test`, in the background once the
change is ready. While iterating, run only the file under change
(`pnpm --filter @gbd/web test:unit -- path/to/thing.test.ts`).

PR 1 and PR 2 additionally run `pnpm test:screenshots`. Only the screens PR 1 names may differ;
regenerate those with `pnpm turbo run screenshots:update --filter=@gbd/web` from the repo root
(not from inside `apps/web`, which captures a stale build) and commit them. A diff on any other
screen is a bug in the refactor, not a baseline to update.

After each PR lands, `/plan-advance .claude/plans/web-app-maintainability.md` folds it in; the PR
that lands the last one deletes the plan.
