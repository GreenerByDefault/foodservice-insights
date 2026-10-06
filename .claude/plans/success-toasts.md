# Success toasts, and an audit of where the UI under-confirms

## Context

After you save a display name on `/account`, nothing says it worked. The button goes
`Saving…` → `Save`, the input already showed the new value, and the name only appears again
inside the closed user menu. The avatar monogram changes only if the initials do. Org rename has
the same gap, softened only by the switcher label changing.

A full audit of every mutating action (20 in all) turned up a wider pattern: the app had **no
success feedback system**, and every success was confirmed only by a change on the page. That works
when the page changes a lot (sign-in, upload, cancel). It fails in three cases:

- **Nothing visible changes where you're looking:** rename self, rename org, resend code.
- **The change happens somewhere else:** create invite (a row appears in a different card), role
  change (no loading state, and the row may re-sort), revoke invite and remove member (the row
  vanishes and focus is lost).
- **Navigation with no explanation:** delete org, leave org and delete report land you on a page
  where the item is just gone. `/orgs` may even redirect you onward.

An inline "Saved" notice fixes only the first case. It can't survive a `goto`, which the third
case needs. So the fix is toasts, the way `cfa-web-app` does it. They have shipped for every
action the audit flagged; what remains is the accessibility gaps the same audit found.

## Pattern

`svelte-sonner` wrapped as shadcn's `ui/sonner`, as in
`~/code/cfa/cfa-web-app/src/lib/components/ui/sonner/`. The wrapper is
[ui/sonner/sonner.svelte](apps/web/src/lib/components/ui/sonner/sonner.svelte), with
`svelte-sonner` in the pnpm catalog, the `mode-watcher` import removed and `theme="light"`
pinned. One `<Toaster position="bottom-right">` is mounted in the root `+layout.svelte`, so a
toast survives navigation. Tests mock the package with
`vi.mock('svelte-sonner', () => import('$lib/testing/toast'))` and assert on `toast.success`
or `toast.error`, resetting with `resetToastMocks()`.

Why a dependency, given AGENTS.md's supply-chain caution: stacking, timing, pause-on-hover,
swipe, keyboard focus (alt+T) and a polite live region are not "simple to write". Sonner is the
shadcn-svelte standard, and `cfa-web-app` already vets it. It has one runtime dependency
(`runed`) and a peer dependency on Svelte 5. The current release is 1.2.1, old enough for pnpm's
`minimumReleaseAge`.

Rules. They are the header comment on `ui/sonner/sonner.svelte`, which is where someone adding
a toast will look:

1. **Toast success only when the outcome isn't obvious where the user is looking**, including
   when a navigation takes away the context. Don't toast when the new page is itself the
   confirmation (sign-in, create org, upload report, cancel, retry).
2. **Errors stay inline.** The existing inline messages persist and carry recovery instructions
   ("Reload to check…"), and a toast would time out before they're read. The one exception is
   sign-out failure, which has no inline place today (it only calls `console.error`).
3. **Toast only after the refresh or navigation resolves.** That means after `await onDone()`,
   `invalidateAll()` or `goto()`, so the toast never claims success before the page reflects it.
4. Copy names the thing: "Deleted Acme Foodservice", not "Success".

Sonner renders each toast as an `li` inside a `region`, so a Playwright `getByRole('listitem')`
that matches on an email or name also matches the toast. Scope row locators to
`page.getByRole('main')`.

The wrapper pins `theme="light"` (the app never sets `.dark`) and maps the popover tokens to
sonner's CSS variables.

## PRs

### PR 1: Accessibility gaps the audit found (not toasts, but the same theme)
- [confirm-action.svelte](apps/web/src/lib/components/confirm-action.svelte): give the error
  line `role="alert"`, and add `aria-busy` plus a busy label on the confirm button.
- [failure-view.svelte](apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/reports/[reportId=uuid]/failure/failure-view.svelte):
  give the retry error `role="alert"`.
- `member-actions.svelte`: role change has an unused `loading` state. Disable the menu trigger
  while a change is pending.
- Restore focus when the focused row disappears (revoke, remove member, decline invite). Move it
  to the list's heading, or to the next row.

## Verification

- `pnpm lint && pnpm check && pnpm test` from the repo root. Run the svelte-autofixer on each
  touched component.
- Drive the app (the `run` skill or Playwright MCP) and check that each changed control announces
  its busy and error states, and that focus lands somewhere sensible after a row disappears.
- No screenshots: nothing here changes how a page looks at rest.
