# @gbd/email

Every email the product sends. Used by the worker parent, for analysis results, and by the web app,
for invitations and the notices to GBD.

**Status: written ahead of its callers.** The messages and the rendering are real and tested;
nothing calls `sendEmail` in production code yet, and there is no transport that actually delivers.
What replaces this paragraph is `apps/worker`'s supervision loop and `apps/web`'s auth routes,
plus the Mailpit transport that lands in a follow-up. The provider is still **Open** in
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) — see
[`src/transports/provider.ts`](src/transports/provider.ts) for what choosing one costs, and why the
seam is shaped the way it is.

Sign-in codes and email-change confirmations are not here. Supabase Auth sends those.

## Using it

A caller says what happened; it never says what the email looks like, and for the GBD notices it
does not choose the recipient either. Adding a new email means adding a member to `EmailMessage` and
a renderer, not touching any caller.

```ts
await sendEmail(emailer, { kind: 'analysis-failed', to, organizationId, reportId, reason });
```

Every function takes an `Emailer` as its first parameter, so callers stay testable. Build one with
`initializeEmailer`, or take whichever your caller already has.

Anything that fails throws an `EmailError`, so a caller can tell email failing apart from a bug of
its own with `isEmailError`. Whether that should fail the work in hand is the caller's to decide:
ARCHITECTURE.md makes delivery best effort, but a failed invitation is worth telling an admin about
and a failed analysis notice is not worth failing an attempt over.

## Testing

Consumers should not send real mail to prove they asked for an email. `recordingEmailer()` from
`@gbd/email/testing` renders for real and keeps the result, so a test asserts on `kind` and `to` and
leaves the copy to this package. It is the only test double this package has today; a stand-in for a
transport that genuinely fails and one that genuinely recovers arrive with the transport itself.
