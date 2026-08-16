# @gbd/email

Every email the product sends.

| Caller | Sends |
| --- | --- |
| Worker parent | Analysis results |
| Web app | Invitations, notices to GBD |

**Status: written ahead of its callers.** The messages and the rendering are real and tested;
nothing calls `sendEmail` in production code yet, and there is no transport that actually delivers.
What replaces this paragraph is `apps/worker`'s supervision loop and `apps/web`'s auth routes,
plus the Mailpit transport that lands in a follow-up. The provider is still **Open** in
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) — see
[`src/transports/provider.ts`](src/transports/provider.ts) for what choosing one costs, and why the
seam is shaped the way it is.

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

## Previewing

`pnpm --filter @gbd/email preview` renders one of every message to `.preview/` (gitignored),
HTML and text side by side — open `.preview/index.html` in a browser.
