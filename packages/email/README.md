# @gbd/email

Every email the product sends.

| Caller | Sends |
| --- | --- |
| Worker parent | Analysis results |
| Web app | Invitations, notices to GBD |

Sign-in codes and email-change confirmations are not here. Supabase Auth sends those.

## Using it

A caller says what happened; it never says what the email looks like. For the GBD notices, the caller
does not choose the recipient either.

```ts
await sendEmail(emailer, { kind: 'analysis-failed', to, organizationId, reportId, reason });
```

Every function takes an `Emailer` as its first parameter, so callers stay testable. Build one with
`initializeEmailer`, or take whichever your caller already has.

Anything that fails throws an `EmailError`, so a caller can tell email failing apart from a bug of
its own with `isEmailError`. Whether that should fail the work in hand is the caller's to decide.

To add a new kind of email, add a member to `EmailMessage` and a renderer for it.

## Testing

Instead of sending real mail to prove a caller asked for an email, consumers should use
`recordingEmailer()` from `@gbd/email/testing`. It renders for real and keeps the result, so a
test asserts on `kind` and `to` and leaves the copy to this package.

This package's own tests prove the Mailpit transport for real. Every test addresses its mail to
`aTestEmailAddress()`, a random recipient nothing else in the suite will use, and reads the mailbox
back with `waitForEmail`/`waitForEmails` rather than truncating — Turbo runs every package's
`test:unit` concurrently against the one mailbox, so a test that emptied it would delete another
package's mail mid-run.

## Previewing

`pnpm --filter @gbd/email preview` renders one of every message to `.preview/` (gitignored),
HTML and text side by side — open `.preview/index.html` in a browser.
