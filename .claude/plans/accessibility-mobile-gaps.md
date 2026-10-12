# Accessibility and mobile gaps

## Context

An audit on 2026-10-11 of the finished web app against WCAG 2.2 AA and phone-keyboard behaviour,
on top of what earlier passes already landed: busy and error states announced and focus kept
when a row disappears (`focusPageHeading`, PR #429), a title on every page for SvelteKit's route
announcer (checked by `routes/page-titles.test.ts`), live regions on the report page and list
(tested), the upload form's file field reachable and operable from the keyboard with focus kept
across its swaps (`new-report.e2e.ts` drives it with Tab and Enter), mobile and tablet
screenshots of every screen, and Svelte's compile-time a11y warnings failing `svelte-check`
(nothing filters them; see `compilerOptions` in [`vite.config.ts`](../../apps/web/vite.config.ts)).
`REQUIREMENTS.md` § Design and accessibility asks for a GBD accessibility review; this is the pass
before it.

What the audit checked and found fine, so nobody re-checks it: every input has a label (the
tests query by it); the OTP field gets `autocomplete="one-time-code"` and `inputmode="numeric"`
from bits-ui (**verified** in `pin-input.svelte.js`); inputs are 16px on phones so iOS does not
zoom on focus; the viewport meta allows zoom; one `<main>` and `<header>` per page, both navs
named, no skipped heading levels, no icon without a name (Lucide sets `aria-hidden` itself,
**verified**); menus and alert dialogs get their roles, labels, Escape handling and focus return
from bits-ui (**verified**); lists are real lists and each row is one link; status is never
colour alone; `--muted-foreground` on white is 4.7:1; every control is at least 24px (2.5.8 AA);
the dialog fits 375px; no `target="_blank"`, no positive `tabindex`, no `100vh`.

Component tests (`*.svelte.test.ts`) run without Tailwind, so `hidden`, `sr-only` and every ring
are inert there — and Chromium forwards `label.focus()` to the labelled control. Whether something
is focusable or visibly focused can only be proven in Playwright (`toBeFocused`, `toHaveCSS`).

Facts marked **verified** were read in the code or `node_modules` on 2026-10-11. Contrast ratios
are computed from the oklch tokens in [`layout.css`](../../apps/web/src/routes/layout.css); the
axe gate in the last PR is what checks them for real.

Each PR re-baselines its own screenshots: `pnpm turbo run screenshots:update --filter=@gbd/web`
from the repo root (see [`e2e/README.md`](../../apps/web/e2e/README.md) § Screenshots), then
review every changed PNG rather than committing the batch.

## Decisions

- *Accepted: an axe-core scan of every captured screen, inside `expectScreenshots`.* A screen
  worth a pixel diff is worth a rules scan, and no spec can forget to call it. One devDependency
  (`@axe-core/playwright`); the PR measures the wall-clock delta and scales back to one scan per
  route if it is more than ~10s locally.
- *Accepted: a darker `--ring` at full opacity, and an inset ring on highlighted menu items.* Both
  are shadcn-svelte defaults that fail 3:1 (1.4.11); the look stays neutral grey.
- *Accepted: real fieldsets around the radio groups, not `aria-labelledby`.* `Field.Set` +
  `Field.Legend variant="label"` is what the Field primitives are built for
  (`has-[>[data-slot=radio-group]]:gap-3`). *Rejected: `aria-labelledby` on the `RadioGroup`*,
  which avoids a 12px spacing shift and a screenshot re-baseline but leaves a `<legend>` outside
  any fieldset.
- *Considered, not done — each a judgement that the cost outweighs the gain:*
  - The reconnecting notice stays `role="alert"`. Losing the connection is worth an interruption,
    and it does not re-announce per poll (the `{#if}` stays mounted while `retrying`).
  - Error pages get no call to action; `error-page.svelte` records why.
  - `monthly-counts.svelte` keeps its polite live region: it speaks once per field, after typing
    pauses, and it is the only progress feedback for a 120-field form.
  - `relative-time.svelte` keeps the absolute time in `title` only. A visible timestamp on every
    row is a design change, not a fix.
  - The sign-out error toast stays as is. It fires only when the auth client itself failed to
    load, and the next click is the retry.
  - Touch targets stay 32–40px. Raising every button to 44px is a redesign; 2.5.8 AA is met.
  - No skip link: two focusable elements precede `<main>` on a phone, three on desktop.
  - The dialog opens with focus on its container (bits-ui default) and its footer puts Confirm
    above Cancel on phones while Tab reaches Cancel first — both shadcn conventions, left alone.
  - The `.dark` block in `layout.css` is dead (nothing applies the class) and is not touched here.

## PR 1 — Radio groups and field errors are announced

- **Three radio groups have no name**: "Weight unit" and "Counts basis" in `upload-form.svelte`
  (`:268`, `:292`) and "Role" in [`invite-form.svelte:84`](../../apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/members/invite-form.svelte)
  each put `Field.Legend` inside `Field.Field`, a `<div role="group">`. A `<legend>` labels only
  as the first child of a `<fieldset>`, so bits-ui's `role="radiogroup"` is announced bare. Swap
  the wrapper for `Field.Set` (nested fieldsets are fine).
- **"Choose lb or kg." neither moves focus nor attaches to the group** (`upload-form.svelte:140`,
  `:284`): the radiogroup root has no `tabindex`, so `.focus()` on it is a no-op. Focus its first
  `[role=radio]`, and put `aria-invalid` and `aria-describedby={errorId}` on the `RadioGroup`.
- **Two field errors are not linked to their input**: the four name outcomes in
  [`organization-name-form.svelte:90-100`](../../apps/web/src/lib/components/orgs/organization-name-form.svelte)
  and "already a member" in `invite-form.svelte:79`. Focus moves to the input but the error is not
  read with it, and inserting the alert at the same moment can cut it off. Copy `email-step.svelte`
  lines 98–108: `aria-invalid` when failed, `aria-describedby` pointing at the `Field.Error`'s `id`.

Tests: `getByRole('radiogroup', { name: 'Weight unit' })` and the other two names in the existing
form tests; `toHaveAccessibleDescription` on the two inputs after a failed submit; the first radio
focused after an empty unit submit. Screenshots: `new-report/*` and `organizations/members-*`
(legend spacing inside a real fieldset is `mb-3` alone, 12px less than before).

## PR 2 — Focus is visible, small text passes, motion can be reduced

All in [`layout.css`](../../apps/web/src/routes/layout.css) and the `ui/` primitives.

- **The focus ring is 1.5:1.** `--ring` is oklch 0.708 (#a1a1a1) and every primitive draws
  `focus-visible:ring-3 focus-visible:ring-ring/50`; at 50% over white that is #d0d0d0. The 1px
  `border-ring` beside it is 2.6:1. Set `--ring: oklch(0.556 0 0)` (#737373, 4.7:1 — the same grey
  as `--muted-foreground`) and drop the `/50` in `button.svelte:7`, both branches of
  `input.svelte`, `radio-group-item.svelte:17`, and `input-otp-slot.svelte:18` (`data-active:`).
  The base layer's `outline-ring/50` on `*` (`layout.css:121`), which colours the browser outline
  on plain links, becomes `outline-ring`; the org tabs already use `focus-visible:outline-ring`.
  The file drop zone's `peer-focus-visible:ring-ring` is already at full opacity and picks up the
  new `--ring` with no edit.
- **A highlighted menu item is 1.1:1.** `dropdown-menu-item.svelte:23` (and `-checkbox-item`,
  `-radio-item`, `-sub-trigger`) uses `outline-hidden` with only `focus:bg-accent` (oklch 0.97).
  bits-ui moves real focus to the item on arrow keys, so add
  `focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`; pointer hover keeps the
  subtle background.
- **Two 12px texts in [`rejection-view.svelte`](../../apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/reports/new/rejection-view.svelte) miss 4.5:1.**
  The example chips (`:70`, muted on `bg-muted`) are 4.35:1 — use `text-foreground`. "Affects the
  whole file" (`:43`, destructive on `bg-destructive/5`) is 4.37:1 — remove the tint; on white the
  red is 4.77:1. (`text-sm` would not help: 14px is still normal-size text.)
- **Nothing honours `prefers-reduced-motion`** except the two spinners' `motion-safe:` guards.
  `tw-animate-css` ships no such rule (**verified**, zero matches in its dist), so dialog and
  menu zoom/fade and the OTP caret blink always play. Add one base-layer rule under
  `@media (prefers-reduced-motion: reduce)` that collapses `animation-duration` and
  `transition-duration` to near zero.

Tests: none of this is testable by assertion beyond the axe gate (PR 6), which checks the contrast
numbers for real. Screenshots: every shot with a focused control (`auth/sign-in-*`,
`account/account*`, possibly the open-menu shots) — review that only the ring changed.

## PR 3 — Focus survives a report action, and a dialog cannot be escaped mid-request

- **Retry and Cancel drop focus to `<body>`.** Retry ([`failure-view.svelte:26-38`](../../apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/reports/[reportId=uuid]/failure/failure-view.svelte))
  unmounts its own button when the view swaps to waiting; Cancel
  ([`cancel-button.svelte:15-25`](../../apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/reports/[reportId=uuid]/waiting/cancel-button.svelte))
  closes a dialog whose trigger is gone, and bits-ui restores focus only to an element still on
  the page (**verified**, `focus-scope.svelte.js`). The live region announces the new state but
  the user has lost their place. `await focusPageHeading()` after `onReportChanged()` in both —
  `member-actions.svelte`'s `remove()` is the precedent. Not for the poll-driven swap from waiting
  to a result: moving focus unprompted is worse than leaving it.
- **Escape closes the confirm dialog while its request is in flight**
  ([`confirm-action.svelte`](../../apps/web/src/lib/components/confirm-action.svelte)): Cancel is
  disabled and outside-clicks are ignored, but Escape is not, and closing resets `actionState`,
  so a failure arriving afterwards is shown to nobody. `AlertDialogContent` spreads `restProps`
  onto the bits-ui content, so pass `onEscapeKeydown` that calls `preventDefault()` while
  `loading`.
- **Where focus goes when the Remove dialog is cancelled is unverified.** It opens from a menu
  item that is gone by the time it closes ([`member-actions.svelte:84`](../../apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/members/member-actions.svelte)).
  Write the test first — open the menu, choose Remove, press Escape, expect the "Manage {name}"
  button focused — and fix only if it fails, by forwarding an `onCloseAutoFocus` from
  `ConfirmAction` that focuses that button.

Tests: the h1 is focused after a retry and after a cancel (`failure-view.svelte.test.ts`,
`cancel-button.svelte.test.ts`; `focus-page-heading.svelte.test.ts` shows how to render an h1
beside the component); Escape during a pending confirm leaves the dialog open
(`confirm-action.svelte.test.ts`); the member-actions focus test above. No screenshots.

## PR 4 — What a screen reader hears

- **Timeline step state is icon and colour only** ([`timeline.svelte:19-30`](../../apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/reports/[reportId=uuid]/waiting/timeline.svelte)):
  only the current step carries `aria-current="step"`; a done step reads as "Waiting to start,
  4 minutes ago". Prefix the title with `<span class="sr-only">Done: </span>` and
  `<span class="sr-only">Not started: </span>`.
- **The organization switcher does not say which org is current**
  ([`organization-switcher.svelte:55`](../../apps/web/src/routes/(app)/shell/organization-switcher.svelte)):
  the check icon is `aria-hidden`. Add `aria-current="page"` to the current org's link.
- **Year headings in `monthly-counts.svelte:39` are `<h3>`** under a page whose only heading is
  the `<h1>`. Make them `<h2>`.

Tests: the listitem text in `timeline.svelte.test.ts`; `aria-current` on the menuitem in
`organization-switcher.svelte.test.ts`; the heading level in `monthly-counts.svelte.test.ts`.
No screenshots (sr-only text and a level change render identically).

## PR 5 — Phone keyboards

- **The typed confirmation can never match on an iPhone.** `confirm-action.svelte:112` is a
  plain text input compared exactly (`:69`); iOS capitalises the first letter of a text field, so
  the delete-account phrase (the user's email) becomes `Eric@…` and the button stays disabled with
  no message. Add `autocapitalize="none" autocorrect="off" spellcheck={false}` (Svelte types
  `autocorrect`; it is Safari-only and harmless elsewhere).
- **Display name** (`display-name-form.svelte:44-52`) gets `autocapitalize="words"`, so a phone
  keyboard capitalises a name without the user reaching for Shift.

Email fields are left alone: `type="email"` already turns off capitalisation and autocorrect on
iOS and Android. Tests: `toHaveAttribute` in the two component tests. No screenshots.

## PR 6 — An axe scan of every captured screen

Lands last so it starts green and guards the rest.

- `@axe-core/playwright` in the `catalog:` block of `pnpm-workspace.yaml`, as a devDependency of
  `apps/web`. It peers on `playwright-core`; with `strictPeerDependencies: true`, add
  `playwright-core` to the catalog and `apps/web` if `pnpm install` objects.
- `apps/web/e2e/lib/a11y.ts` exports `expectNoA11yViolations(page)`: `new AxeBuilder({ page })
  .analyze()` and `expect(violations).toEqual([])` — the full violation objects, so a failure
  names the rule, the node and the fix. It works through `page.evaluate`, so the container
  browser is no obstacle.
- [`expectScreenshots`](../../apps/web/e2e/lib/screenshots.ts) calls it once, at the desktop
  viewport, before the capture loop; a spec that wants a scan without a screenshot can call it
  directly. Update the table in `e2e/README.md`: `*.screenshot.ts` asserts pixels and rules.
- Expect a few rules to need a documented exclusion rather than a fix — SvelteKit's own route
  announcer `<div>` sits outside any landmark (`region`), and sonner's toaster may trip
  `aria-allowed-attr`. Disable per rule in the helper with a one-line reason each, never
  globally; a violation on our own markup is fixed, not excluded.
- Time `pnpm --filter @gbd/web test:screenshots` before and after, twice each, and put both
  numbers in the PR description. Over ~10s added locally, fall back to scanning in one spec per
  feature folder instead of every screen.

## Verification

Per PR, from the repo root: `pnpm lint && pnpm check && pnpm test`, and `svelte-autofixer` on
every `.svelte` file touched. Re-baseline screenshots with the turbo command in Context and read
each changed image.

Drive the app for what tests cannot prove (the `run` skill or the Playwright MCP):

- PR 2: Tab through the sign-in form, a page of buttons, and an open menu with the arrow keys;
  every focused control is unmistakable against white.
- PR 5, if a phone is to hand: Safari on iOS, Account → Delete account, type the email — the
  first letter stays lowercase and the button enables.
- PR 6: the suite passes with zero violations, and introducing a deliberate one (remove a label
  locally) fails it with a readable message.
