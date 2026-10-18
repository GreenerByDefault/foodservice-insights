# Account deletion that works, and takes its invites with it

## Context

`REQUIREMENTS.md` § Data deletion has a user's account hard-deleted, keeping their reports with
no creator and their raw user id in the audit log. Two things are wrong with that today: deletion
fails outright for almost every real user, and where it succeeds, our tables keep the invites the
user answered, which nothing needs once the account is gone and which put their address back
beside the id.

Facts from the tree (2026-10-18) that shape the design:

- **Deleting a user who has ever run an analysis fails.** `analysis_attempt.requested_by_user_id`
  is `ON DELETE SET NULL`, and Postgres applies that as an `UPDATE`, which fires
  `analysis_attempt_terminal_is_final`. That trigger freezes every column of a finished attempt
  except the four notification ones, so the cascade raises `check_violation` and the whole delete
  rolls back. Reproduced on the test stack. `_deleteAccount` catches only the last-admin
  violation, so the user sees a 500; deleting the user in the Supabase dashboard fails the same
  way. [`delete-account.test.ts`](../../apps/web/src/routes/api/account/delete-account.test.ts)
  misses it because its report has no attempt, and a real report always has one.
  [`alerts.md`](alerts.md)'s *stuck* rule and [`metrics-pipeline.md`](metrics-pipeline.md)'s
  `has_requester` both assume the nulling works.
- **The other `SET NULL` foreign keys onto `app_user` are unblocked**: `report`,
  `rejected_upload`, `organization` and `organization_invite` have no freezing trigger.
- **`organization_invite.email` outlives the account.** Invites go only when their organization
  does. The `invite.accepted`, `invite.declined` and `invite.expired` audit rows have the
  answering user as `actor_user_id` and the invite as `target_id`, so joining `audit_event` to
  `organization_invite` turns a deleted user's id back into their address. The address on the
  invite is the one it was sent to, which may not be the account's current one, since a user can
  change their email.
- **Nothing reads a non-pending invite's email.** Every read filters `status = 'pending'`, except
  `countInvitesSince`, which counts by `invited_by_user_id`, and `lockInviteForEmailOrNotFound`,
  which only ever matches the signed-in user's own address.

Out of scope:
- An invitee who never signs up keeps their address on the invite until the organization is
  deleted, since there is no account to delete.
- GoTrue's own `auth.audit_log_entries`, which pairs user ids with addresses and IPs, is kept.
- Copies outside the database (Postmark, the GBD inbox, Better Stack, Supabase's logs and
  backups) belong in the privacy policy.

## Decisions

- **A finished attempt's requester may become null, and nothing else.** The trigger masks
  `requested_by_user_id` out of its row comparison, and separately requires that it is either
  unchanged or null. So the cascade passes, and an `UPDATE` that reassigns a finished attempt to
  someone else still fails.
  *Rejected: masking the column like the notification ones.* That would let any write change who
  asked for a finished analysis, which the trigger exists to prevent.
  *Rejected: `ON DELETE NO ACTION` and nulling by hand in `_deleteAccount`.* A delete from the
  Supabase dashboard would then fail with a foreign key error instead.
- **The trigger function says why the column is there**: a column that a foreign key sets null
  on delete must be one it lets become null. That is the rule a later `SET NULL` column on
  `analysis_attempt` has to follow.
- **Deleting an account deletes the invites its user answered**, in the same transaction, before
  the `auth.users` delete: every `organization_invite` that is the `target_id` of one of the
  user's `invite.accepted`, `invite.declined` or `invite.expired` audit rows. Found through the
  audit rows rather than by address, because the address may have changed since. Those rows are
  never `pending`, and nothing reads them.
  - Pending invites to the user's address stay. They are an admin's live intent, the user may
    come back, and no audit row ties them to the deleted id.
  - `countInvitesSince` counts an admin's invites over the past hour, superseded ones included.
    An answered invite deleted inside that hour lets its inviter send one more. That is harmless.
  *Rejected: matching on the account's current address.* It misses invites answered under an
  earlier one, which are exactly the rows that link.
  *Rejected: clearing `email` whenever an invite leaves `pending`.* It needs `email` nullable and
  a CHECK tied to status, and an invite past its deadline stays `pending` until dismissed, so it
  still would not cover everyone.

## Order

PR 1 first: until it lands, deletion fails for anyone who has used the product. PR 2 is
independent of it. Whichever lands last deletes this plan.

## PR 1 — a finished attempt's requester can be deleted

- `packages/db/migrations/0NN_finished_attempt_requester.ts`, taking the next free number:
  `CREATE OR REPLACE FUNCTION analysis_attempt_check_terminal_is_final()` with the mask and the
  null-or-unchanged check from Decisions, and the comment naming the rule.
- `packages/db/tests/analysis-attempt.test.ts`, inside `withRollback`:
  - Deleting the requester of a `succeeded`, a `failed` and a `canceled` attempt nulls
    `requested_by_user_id` on each.
  - Setting a finished attempt's requester to another user is refused with
    `analysis_attempt_terminal_is_final`.
- `apps/web/src/routes/api/account/delete-account.test.ts`: the first test's report gets a
  finished attempt the user requested (`insertReportWithAttempt`), and the test asserts the
  attempt survives with a null requester.
- `packages/db/README.md` § The analysis attempt state machine: the frozen-row paragraph adds
  `requested_by_user_id`, which may only become null.
- `pnpm db:gen-types`. The migration changes only a function body, so the dump changes and the
  types do not.

## PR 2 — deleting an account deletes the invites it answered

- `_deleteAccount` deletes the answered invites from Decisions before the `auth.users` delete.
  The audit actions come from `InviteAuditAction`, so a renamed action fails to typecheck here.
- `delete-account.test.ts`:
  - An accepted, a declined and a dismissed-expired invite to the user are gone afterwards,
    including one sent to an address the user no longer has.
  - A pending invite to the user's address stays, as does an answered invite to someone else.
- `REQUIREMENTS.md` § Data deletion: under "The raw user ID stays in the audit log", one line
  saying the invites the user answered are deleted with the account.

## Verification

Each PR is verified by `pnpm lint && pnpm check && pnpm test`. PR 1 adds a migration, so test it
against a private database until it lands ([`README.md`](../../README.md) § Add a database
migration). Then by hand:

- After PR 1, in the dev app: run an analysis to the end, delete the account, and the report
  page shows the submitter as a deleted user.
- After PR 2, as that user: accept an invite, delete the account, and
  `SELECT * FROM organization_invite WHERE id IN (SELECT target_id FROM audit_event WHERE
  actor_user_id = '<id>')` returns nothing.
