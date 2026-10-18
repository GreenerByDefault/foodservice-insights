# Real sign-in in production

> **Status:** a spec. Until production can send sign-in codes, it runs `PUBLIC_AUTH_MODE=placeholder`:
> every request is one seeded admin, behind a site password
> ([`.do/web.yaml`](../../.do/web.yaml)). This plan switches production to Supabase Auth,
> then deletes placeholder mode. It starts once two things are true: Supabase sends through
> Postmark, per [`email-provider.md`](email-provider.md) § Supabase Auth's settings; and Postmark
> has approved the account. The PR that lands the last step deletes this file.

## Order of operations

Go-live spans three plans. GBD's part comes first and is one sitting; everything after it is
Eric's.

1. **GBD:** the insights@ mailbox and the DNS records on both domains, from the handoff doc Eric
   sends once Postmark has shown him the DKIM record
   ([`email-provider.md`](email-provider.md) § Before PR 1 steps 3 and 4,
   [`custom-domain.md`](custom-domain.md) § Before PR 1 step 1).
2. Postmark verifies the domain, the first send passes DMARC, and Supabase Auth gets its SMTP
   settings and templates (`email-provider.md`).
3. `SITE_URL`, Supabase's Site URL, and `custom-domain.md`'s PR: the app answers at
   `insights.greenerbydefault.com`. This needs only the CNAME, so it can run alongside 2.
4. `email-provider.md`'s PR: production sends through Postmark. Not before 2, since
   `EMAIL_TRANSPORT=provider` is what keeps mail from going out under `p=reject` until the DNS
   verifies.
5. Postmark approves the account.
6. This plan: § Before PR 1, then PR 1 and PR 2.

## Before PR 1: the hosted project

In the production Supabase project:

- **Turn "Confirm email" on.** GoTrue's `/signup` is public. With confirmations off, it returns a
  session for any address without verifying it, and claiming an invite would take that session as
  proof that the user owns the address. Local stacks leave confirmations off, because only
  developers use them. Turn this on only after `email-provider.md`'s templates are in place.
  Otherwise new users get GoTrue's default link instead of a code.
- **Turn the Data API off.** Nothing uses it. With no RLS, it could expose the tables to the
  publishable key that the browser holds once sign-in is live.
- **Decide what happens to the placeholder organization.** Its reports belong to an address nobody
  can sign in as. Either add a real admin to it in Studio, or accept that its data is abandoned.
- **Sign in end to end with an address outside greenerbydefault.org.** This also proves that
  Postmark approved the account.

*Considered, not done: a CAPTCHA on sign-in.* Anyone can request a code for any address. A run of
requests for bad addresses would bounce through Postmark's `auth` stream, and Postmark reviews
accounts on their bounce rate. Supabase Auth supports Cloudflare Turnstile. Add it at the first
bounce spike on `auth`.

## PR 1 — production signs in for real

- `.do/web.yaml` sets `PUBLIC_AUTH_MODE=supabase`.
- Take down the site password that stands in front of placeholder mode (the code goes in PR 2).
- `tests/e2e`'s run flips to `supabase` in the same PR.
  [`test-run.ts`](../../tests/e2e/scripts/test-run.ts) runs it as `placeholder` only because that
  is how production runs today.

## PR 2 — delete placeholder mode

With one mode left, `PUBLIC_AUTH_MODE` goes too. This PR removes:

- [`mode.ts`](../../apps/web/src/lib/auth/mode.ts) and every place that branches on the mode,
  including the browser's branch that avoids loading supabase-js and the one in `hooks.server.ts`;
- `PUBLIC_AUTH_MODE` in `.env.example`, `.env.test`'s note, `turbo.json`, and
  `tests/e2e/scripts/containers.ts`;
- `pnpm seed:identity`: its script in `packages/db`, its turbo task, its root script, and the
  `deploy.yml` step that runs it;
- the browser-testing fixtures' `placeholder` branch;
- the site password: `SITE_PASSWORD` (`.env.example`, `turbo.json`, `tests/e2e/scripts/containers.ts`,
  the Environment secret), [`site-password.ts`](../../apps/web/src/lib/server/auth/site-password.ts),
  and the `api/site-session` route.

After this, `pnpm dev` signs in with codes caught by Mailpit, so `apps/web/README.md` § Auth and
the root README need to say so. The PR also deletes this plan.
