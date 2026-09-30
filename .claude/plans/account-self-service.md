# Account self-service: change email

## Context

`/account` renames the user (`auth.md` § The display-name form) and deletes the account
(`routes/(app)/account/delete-account.svelte`, `DELETE /api/account`); this plan adds the last row
of the roles table that `/account` still lacks — changing your email. The page's `**Stub:**`
comment is where it goes.

**It is `supabase`-mode only** (`auth.md` § The mode switch): in `placeholder` there is no session
to change. `/account/+page.svelte` already wraps the delete section in `{#if authMode() ===
'supabase'}`; the form joins it there, and `page.svelte.test.ts` already renders the page under
each mode with `$lib/auth/mode` mocked.

**Screenshots of `/account` use a fresh user, not the pinned identity.** The pinned identity is
shared, so which organizations it is the only admin of — and so what the delete section shows —
depends on which specs ran first. `account.screenshot.ts`'s `showEmailAs` fixture instead rewrites
a fresh user's mirror in the run database to a fixed address, one per test (`auth.users` holds
each once), and restores it at teardown. A new screenshot of the form follows that pattern.

**One decision that reads the requirements differently, for you to confirm:** changing email uses
**single confirmation at the new address** (`double_confirm_changes = false`). Two codes in two
inboxes is the magic-link ceremony OTP was chosen to avoid, and the user is already freshly
authenticated.

## Settled decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Change email | Browser: `updateUser({ email })` → code to the new address → `verifyOtp({ email, token, type: 'email_change' })` → `invalidateAll()` | The stub's design; no route of ours |
| Confirmation mode | `[auth.email] double_confirm_changes = false`; `supabase-dev/supabase/templates/email-change.html` with `{{ .Token }}`, referenced from both local stacks as `sign-in-code.html` is; hosted dashboard flagged in the PR body | Context, above |
| Pending invites to the old address | Stay addressed to it | Accepted edge; the invite can be re-sent |

## PR 1 — Change email

- Supabase config in both stacks: `double_confirm_changes = false`, `[auth.email.template.email_change]
  content_path` → our template with `{{ .Token }}`, the way `[auth.email.template.magic_link]`
  already is. Verify by hand against Mailpit first.
- `BrowserAuth` gains `updateUser`; `$lib/auth/testing/fake.ts` follows.
- `account/change-email-form.svelte`: two steps, `'email' | 'code'`, reusing
  `$lib/components/auth/code-step.svelte` (its second caller) and `describeAuthError`. Takes `auth`
  as a prop, as `delete-account.svelte` does. Verified → `invalidateAll()`; the menu and page show
  the new address. Component tests with the fake: the address is trimmed and sent, a bad code
  stays on the step with the mapped message.
- **E2E**: change to `aTestEmailAddress()`, `waitForEmail(newAddress)` for the code, submit, the form
  reports success, and GoTrue's admin API (`admin.getUserById`) returns the new address. **Not** that
  `/account` or the menu shows it: GoTrue writes the change to the stack's main database and the app
  reads the run's clone (`auth.md` § Two facts, 2), so in e2e the page keeps the old address. In
  production both are one database; the menu updating is the component test's `invalidateAll()`
  plus the `pnpm dev` check below. An e2e of it would need a Playwright project pointed at the
  stack's main database, which `auth.md` judged not worth building.
- `account.png` regenerates. Remove the last `**Stub:**` marker on `/account`. Deletes this plan
  file.

## Verification

As usual, plus `TEST_DB=1 scripts/supabase stop && start` for the template. Then `pnpm dev`: change
email → a six-digit code and no link arrives at the new address in Mailpit → after the code, the
menu shows it. (The dev stack's GoTrue and app share one database, so this is the check e2e cannot
make.)
