# Accessibility gaps in action feedback

## Context

Success toasts have shipped for every mutating action that needed one (see
[ui/sonner/sonner.svelte](apps/web/src/lib/components/ui/sonner/sonner.svelte) for the rules).
The audit that drove them also found accessibility gaps in how actions report their busy and
error states, and in where focus goes when the focused row disappears. Those remain.

Sonner renders each toast as an `li` inside a `region`, so a Playwright `getByRole('listitem')`
that matches on an email or name also matches the toast. Scope row locators to
`page.getByRole('main')`.

## PRs

### PR 1: Announce busy and error states, and keep focus
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
