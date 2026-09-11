# Account self-service: delete account and change email

## Context

`/account` is a stub. `auth.md` PR 4 gives it a working display-name rename and its first
screenshot; this plan adds the other two rows of the roles table — change email, delete account —
and the rule REQUIREMENTS § Data deletion attaches to the second: an admin is blocked from deleting
their account until they promote someone or delete the organization.

**Depends on** `auth.md` PRs 3 and 4 (a real session to end; the `/account` page and `BrowserAuth`
to extend). The widened `AuditEvent` (`target`, `detail`, `lib/server/audit.ts`) and
`isCheckViolation` (`lib/server/db.ts`) this plan needs have already landed — except
`AuditTarget`'s `'user'` branch requires a real `organizationId`, since nothing needed a null one
yet; this plan's `user.deleted` is the first
caller with no organization, so its PR 1 also widens that branch to `organizationId: OrganizationId
| null`. Nothing here is worth landing before real sign-in — `invites.md` § Sequencing has the
table and the order across all three plans. It also retires the two `/account` bullets in `auth.md`
§ Follow-ups.

**Two decisions that read the requirements differently, for you to confirm** (the other three are
in `invites.md` § Sequencing):

- The account is deleted by **`DELETE FROM auth.users` in our own transaction**, not through
  GoTrue's admin API. The audit row, the sole-admin trigger and the delete are then atomic, and the
  secret key stays out of the app. `auth-schema.sql` shows GoTrue's own tables — identities,
  sessions, one_time_tokens, mfa_* — all `ON DELETE CASCADE` from `auth.users`. The `/account`
  stub's comment assumed the service-role key; this replaces that assumption.
- Changing email uses **single confirmation at the new address** (`double_confirm_changes =
  false`). Two codes in two inboxes is the magic-link ceremony OTP was chosen to avoid, and the
  user is already freshly authenticated.

## Settled decisions

| Decision | Choice | Why |
| --- | --- | --- |
| How the user is deleted | `DELETE FROM auth.users WHERE id = …` in our transaction | Context, above. `organization_member_at_least_one_admin` fires on the cascade (`organization.test.ts:346`). Rejected: `admin.deleteUser` — not transactional, needs `SUPABASE_SECRET_KEY` in prod |
| Sole-admin block | Loader lists organizations where the user is the only admin; the UI disables delete and links each org's Members page; the server maps the trigger to 409 `{ code: 'last-admin' }` via `SET CONSTRAINTS … IMMEDIATE` | Same shape as memberships: server side is `attemptMemberWrite` + `lastAdminResponse` (`lib/server/orgs/members.ts`, used by the members `+server.ts`) |
| Confirmation | `ConfirmAction` with `confirmPhrase` = the user's email | The delete-organization pattern, typing the name |
| Ending the session | After 204: `browserAuth().signOut({ scope: 'local' })`, then `goto('/', { invalidateAll: true })` | supabase-js tolerates GoTrue's 401/403/404 on logout for a dead user and still clears the local session; server-side, auth PR 3 already treats a deleted user's token as signed-out-and-clear |
| The user's reports | Stay, `created_by_user_id → NULL` (existing FK). `lib/server/reports/guards.ts` then grants no member ownership of them; admins still can | REQUIREMENTS; nothing in the UI shows a submitter today, so "displayed as a deleted user" has nowhere to render yet |
| GBD notice | `gbd-user-deleted` after commit — already defined, no caller | REQUIREMENTS § GBD email notifications |
| Audit | `user.deleted`, `organizationId: null`, target user | The id survives in `audit_event`, which has no FKs for exactly this |
| Change email | Browser: `updateUser({ email })` → code to the new address → `verifyOtp({ email, token, type: 'email_change' })` → `invalidateAll()` | The stub's design; no route of ours |
| Confirmation mode | `[auth.email] double_confirm_changes = false`; `templates/email-change.html` with `{{ .Token }}` in both local stacks; hosted dashboard flagged in the PR body | Context, above |
| Pending invites to the old address | Stay addressed to it | Accepted edge; the invite can be re-sent |

## PR 1 — Delete account

- `DELETE /api/account` → `_deleteAccount(db, { user })`: `SET CONSTRAINTS … IMMEDIATE`; audit
  `user.deleted`; `DELETE FROM auth.users` in a `try` → `isCheckViolation(…,
  'organization_member_at_least_one_admin')` → 409 `last-admin`; after commit
  `notifyGbd({ kind: 'gbd-user-deleted', userEmail })`; 204. `delete-account.test.ts`: `auth.users`
  and `app_user` rows gone, memberships gone, their reports remain with a null creator, the audit row
  (null organization), the GBD notice (`recordingEmailer`), sole admin → 409 and nothing deleted,
  `mockUnreachableEmailer` does not undo the delete.
- `account/+page.server.ts`: `_loadSoleAdminOrganizations(db, userId)` → `{ id, name }[]` (admin
  row, and the org's admin count is 1). Test.
- `account/delete-account.svelte`: `Field.Set` "Delete account"; with sole-admin orgs, the
  explanation and a link per org to `organizationMembersHref`, trigger disabled; otherwise
  `ConfirmAction` typing the email. Client `$lib/account/api/delete-account.ts` (throws). Component
  tests for both states and the post-success `signOut` + `goto('/')` (fake `BrowserAuth`).
- **E2E** `account/account.e2e.ts` (per-test identities): sole admin → delete disabled and the org
  named; with `members: [{ role: 'admin' }]` → type the email → confirm → `/` → the org URL answers
  401 → `readMailbox(gbd address)` has a subject naming the user's email.
- **Screenshots**: `account.png` regenerates; `account-sole-admin.png` (the blocked state — a
  paragraph and links that carry visual risk).

## PR 2 — Change email

- Supabase config in both stacks: `double_confirm_changes = false`, `[auth.email.template.email_change]
  content_path` → our template with `{{ .Token }}`. Verify by hand against Mailpit first (the
  "template override failed" risk auth PR 3 retires applies here too).
- `BrowserAuth` gains `updateUser`; `$lib/auth/testing/fake.ts` follows.
- `account/change-email-form.svelte`: two steps, `'email' | 'code'`, reusing
  `$lib/components/auth/code-step.svelte` (its second caller) and `describeAuthError`. Verified →
  `invalidateAll()`; the menu and page show the new address. Component tests with the fake: the
  address is trimmed and sent, a bad code stays on the step with the mapped message.
- **E2E**: change to `aTestEmailAddress()`, `waitForEmail(newAddress)` for the code, submit, `/account`
  and the menu show the new email.
- `account.png` regenerates. Remove the last `**Stub:**` markers on `/account`; `auth.md`
  § Follow-ups loses its two `/account` bullets. Deletes this plan file.

## Verification

Per PR as usual; PR 2 also `TEST_DB=1 scripts/supabase stop && start` for the template. Then `pnpm
dev`: as the only admin of an org, `/account` refuses to delete and links the org; promote someone,
and the dialog opens; type the wrong email and the button stays disabled; delete → `/`, and Back
shows no signed-in shell. Change email → a six-digit code and no link arrives at the new address in
Mailpit → after the code, the menu shows it.
