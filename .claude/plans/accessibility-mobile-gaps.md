# Accessibility and mobile gaps

## Context

An audit on 2026-10-11 of the finished web app against WCAG 2.2 AA and phone-keyboard behaviour,
on top of what earlier passes already landed: busy and error states announced and focus kept
when a row disappears (`focusPageHeading`, PR #429), a title on every page for SvelteKit's route
announcer (checked by `routes/page-titles.test.ts`), live regions on the report page and list
(tested), the upload form's file field reachable and operable from the keyboard with focus kept
across its swaps (`new-report.e2e.ts` drives it with Tab and Enter), every radio group named
and every inline field error tied to its input with `aria-invalid` and `aria-describedby`
(asserted in the form component tests), phone keyboards told what the field is (the typed
confirmation in `confirm-action.svelte` turns off autocapitalise, autocorrect and spellcheck so
iOS cannot break its exact match; the display name capitalises words; email fields need nothing,
since `type="email"` already does it), state a screen reader would otherwise miss put into
words (each waiting-timeline step says "Done:" or "Not started:" in `sr-only` text beside its
icon, and the organization switcher marks the current org `aria-current="true"` — not `"page"`,
since its link goes to the org's home and you are usually on a page below it), focus kept when
a report action swaps the view (Retry and Cancel move it to the h1 with `focusPageHeading`, and
the Remove-member dialog hands it back to the "Manage {name}" trigger even though the menu item
that opened it is gone — bits-ui does that unaided, and `member-actions.svelte.test.ts` pins it),
the confirm dialog refusing Escape while its request is in flight (closing would reset
`actionState` and hide a late failure), mobile and tablet screenshots of every screen, and Svelte's compile-time a11y warnings failing `svelte-check`
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
  - The poll-driven swap from waiting to a result leaves focus where it is. Only a swap the user
    asked for (Retry, Cancel) moves it; moving focus unprompted is worse than leaving it.
  - No skip link: two focusable elements precede `<main>` on a phone, three on desktop.
  - The dialog opens with focus on its container (bits-ui default) and its footer puts Confirm
    above Cancel on phones while Tab reaches Cancel first — both shadcn conventions, left alone.
  - The `.dark` block in `layout.css` is dead (nothing applies the class) and is not touched here.

## PR 1 — Focus is visible, small text passes, motion can be reduced

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

Tests: none of this is testable by assertion beyond the axe gate (PR 2), which checks the contrast
numbers for real. Screenshots: every shot with a focused control (`auth/sign-in-*`,
`account/account*`, possibly the open-menu shots) — review that only the ring changed.

## PR 2 — An axe scan of every captured screen

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

- PR 1: Tab through the sign-in form, a page of buttons, and an open menu with the arrow keys;
  every focused control is unmistakable against white.
- If a phone is to hand: Safari on iOS, Account → Delete account, type the email — the
  first letter stays lowercase and the button enables.
- PR 2: the suite passes with zero violations, and introducing a deliberate one (remove a label
  locally) fails it with a readable message.
