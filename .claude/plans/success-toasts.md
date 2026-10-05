# Success toasts, and an audit of where the UI under-confirms

## Context

After you save a display name on `/account`, nothing says it worked. The button goes
`Saving…` → `Save`, the input already showed the new value, and the name only appears again
inside the closed user menu. The avatar monogram changes only if the initials do. Org rename has
the same gap, softened only by the switcher label changing.

A full audit of every mutating action (20 in all) turned up a wider pattern. The app has **no
success feedback system**: every success is confirmed only by a change on the page. That works
when the page changes a lot (sign-in, upload, cancel). It fails in three cases:

- **Nothing visible changes where you're looking:** rename self, rename org, resend code.
- **The change happens somewhere else:** create invite (a row appears in a different card), role
  change (no loading state, and the row may re-sort), revoke invite and remove member (the row
  vanishes and focus is lost).
- **Navigation with no explanation:** delete org, leave org and delete report land you on a page
  where the item is just gone. `/orgs` may even redirect you onward.

An inline "Saved" notice fixes only the first case. It can't survive a `goto`, which the third
case needs. So the fix is toasts, the way `cfa-web-app` does it.

## Pattern

`svelte-sonner` wrapped as shadcn's `ui/sonner`, as in
`~/code/cfa/cfa-web-app/src/lib/components/ui/sonner/`. The wrapper is already vendored at
[ui/sonner/sonner.svelte](apps/web/src/lib/components/ui/sonner/sonner.svelte), with
`svelte-sonner` in the pnpm catalog, the `mode-watcher` import removed and `theme="light"`
pinned. It is not mounted anywhere yet. There is one `<Toaster>` in the root `+layout.svelte`,
so a toast survives navigation.

Why a dependency, given AGENTS.md's supply-chain caution: stacking, timing, pause-on-hover,
swipe, keyboard focus (alt+T) and a polite live region are not "simple to write". Sonner is the
shadcn-svelte standard, and `cfa-web-app` already vets it. It has one runtime dependency
(`runed`) and a peer dependency on Svelte 5. The current release is 1.2.1, old enough for pnpm's
`minimumReleaseAge`.

Rules. They go in a short header comment on `ui/sonner/sonner.svelte`, which is where someone
adding a toast will look:

1. **Toast success only when the outcome isn't obvious where the user is looking**, including
   when a navigation takes away the context. Don't toast when the new page is itself the
   confirmation (sign-in, create org, upload report, cancel, retry).
2. **Errors stay inline.** The existing inline messages persist and carry recovery instructions
   ("Reload to check…"), and a toast would time out before they're read. The one exception is
   sign-out failure, which has no inline place today (it only calls `console.error`).
3. **Toast only after the refresh or navigation resolves.** That means after `await onDone()`,
   `invalidateAll()` or `goto()`, so the toast never claims success before the page reflects it.
4. Copy names the thing: "Deleted Acme Foodservice", not "Success".

Settings: `position="bottom-right"`, set where the toaster is mounted. The wrapper already
pins `theme="light"` (the app never sets `.dark`) and maps the popover tokens to sonner's CSS
variables.

## PRs (stacked, each small)

### PR 1: Mount the toaster; confirm renames (the reported bug)
- Add the rules above as a header comment on `ui/sonner/sonner.svelte`.
- Mount `<Toaster>` in [+layout.svelte](apps/web/src/routes/+layout.svelte).
- [display-name-form.svelte](apps/web/src/lib/components/account/display-name-form.svelte):
  after `await onSaved()`, call `toast.success('Your name was updated')`.
- [rename-form.svelte](apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/settings/rename-form.svelte):
  after `invalidateAll()`, call `toast.success(\`Renamed to ${name}\`)`. It lives here, not in
  the shared `organization-name-form.svelte`, because create-org navigates and doesn't toast.
- Add `$lib/testing/toast.ts`, a `vi.mock('svelte-sonner')` factory with `toast.success/error`
  spies, following `$lib/testing/navigation.ts`. Extend the success tests to assert the toast
  call, and the unknown-outcome tests to assert no toast.
- **Add one screenshot, and only one:** the name-saved toast, added to
  `e2e/account/account.screenshot.ts`. It runs across that file's 3 viewports.
  - Why one is worth having: the toast's appearance comes from one wrapper plus the popover
    tokens, and only a screenshot can check it. That means the colours, the border, where it
    sits on mobile (sonner goes full-width there), and whether it covers the page chrome.
  - Why only one: every other toast uses the same component with different words, and the unit
    tests already check the words. More screenshots would add maintenance and possible flakes
    but no new coverage.
  - Flake guards: stop the clock (`page.clock.install()` before the save) so the 4s auto-dismiss
    can't fire mid-capture, and wait for `[data-sonner-toast][data-mounted="true"]` so the
    entry animation has finished.
  - If this screenshot turns out to be flaky or noisy, delete it rather than chase it. Nothing
    else depends on it.

### PR 2: Confirm actions that navigate away
- [settings/delete-button.svelte](apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/settings/delete-button.svelte):
  "Deleted {org}".
- [members/your-membership.svelte](apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/members/your-membership.svelte):
  leaving shows "You left {org}". Stepping down shows "You're no longer an admin of {org}",
  because the page changes a lot there without saying why.
- [reports/[reportId]/delete-button.svelte](apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/reports/[reportId=uuid]/delete-button.svelte):
  "Deleted {report name}". This needs the name passed as a prop if it isn't already.
- [invites/invite-offer.svelte](apps/web/src/routes/(app)/invites/invite-offer.svelte): accepting
  shows "You joined {org}", and declining shows "Declined the invitation to {org}".
- Add or extend one e2e test (delete org) that asserts the toast shows on the destination page,
  to prove the toast survives the `goto`.

### PR 3: Members page and auth
- [invite-form.svelte](apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/members/invite-form.svelte):
  "Invited {email}" only when `emailSent`. Otherwise keep the inline "couldn't email them"
  notice and give it `role="status"`.
- [member-actions.svelte](apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/members/member-actions.svelte):
  role change shows "{name} is now an admin/member", and remove shows "Removed {name}".
- [pending-invite-row.svelte](apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/members/pending-invite-row.svelte):
  "Revoked the invitation for {email}".
- [code-step.svelte](apps/web/src/lib/components/auth/code-step.svelte): resend shows "Sent a
  new code to {email}".
- [user-menu.svelte](apps/web/src/routes/(app)/shell/user-menu.svelte): sign-out failure shows
  `toast.error("Couldn't sign out. Try again.")`.

### PR 4: Accessibility gaps the audit found (not toasts, but the same theme)
- [confirm-action.svelte](apps/web/src/lib/components/confirm-action.svelte): give the error
  line `role="alert"`, and add `aria-busy` plus a busy label on the confirm button.
- [failure-view.svelte](apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/reports/[reportId=uuid]/failure/failure-view.svelte):
  give the retry error `role="alert"`.
- `member-actions.svelte`: role change has an unused `loading` state. Disable the menu trigger
  while a change is pending.
- Restore focus when the focused row disappears (revoke, remove member, decline invite). Move it
  to the list's heading, or to the next row.

PR 4 is independent of 1–3 and can land in any order.

## Verification (per PR)

- `pnpm lint && pnpm check && pnpm test` from the repo root. Run the svelte-autofixer on each
  touched component.
- Drive the app (the `run` skill or Playwright MCP): do each action and check that the toast
  appears once, on the right page, with the right copy, and that failures still show inline
  with no toast.
- Screenshot baselines: PR 1 adds the one toast baseline (regenerate through turbo, not from
  `apps/web`). Existing baselines should not change, because a toast appears only after an
  action. PRs 2–4 add no screenshots. They are covered by the unit-level toast assertions plus
  the one e2e test in PR 2 that checks a toast survives navigation.
