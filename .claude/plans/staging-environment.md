# The staging environment

## Context

`REQUIREMENTS.md` § Maintainability asks for a staging environment in one line, and nothing else in
the repo designs one. This is that design. It is **not** scheduled — it waits until prod exists and
is boring — but it is written down now because
[`deploy-image-registry.md`](deploy-image-registry.md) was shaped so this stays a small diff, and
that claim is worth being checkable.

The load-bearing property is already in place: **there is one image per commit and it is
environment-agnostic**, so promotion is a pointer move and staging cannot drift from prod by way of
a rebuild. Nothing here needs a second build.

## What actually has to be built

Most of the work is not GitHub Actions.

- **A second Supabase project** — database, blob store, and auth are one platform per
  `ARCHITECTURE.md` § Supabase, so staging needs its own. Locally there are already two independent
  stacks driven through `scripts/supabase`; this is the hosted equivalent. Whatever answer
  [`deploy-migrations.md`](deploy-migrations.md)'s Open reaches about a GitHub runner reaching the
  database — Supavisor session mode, IPv4 — has to be arranged a second time here.
- **A second set of config**, including `SITE_URL`, the S3 credentials, and the email variables.
  Staging must not send mail to real addresses — point `EMAIL_TRANSPORT` at a catcher.
- **Two more provider services** (web and worker) on smaller instances.

**Open:** whether the staging worker runs `WORKER_MODE=stubbed` or the real pipeline. Real means
`GEMINI_API_KEY`/`OPENAI_API_KEY`/`LLM_WHISPERER_API_KEY` spend on every staging run; stubbed means
staging never exercises the thing most likely to break. Probably real with a separate, small budget,
but it is a cost decision.

## The pipeline diff

- **`environment` becomes a dimension.** A `workflow_dispatch` choice input, `staging` and `prod`,
  and `environment:` on the deploy jobs so **GitHub Environments supply the secrets**. That last
  part is the whole reason this is small: `${{ secrets.PROVIDER_API_KEY }}` stays character-for-
  character identical between environments, instead of sprouting a
  `env == 'staging' && secrets.X_STAGING || secrets.X_PROD` ternary at every use site. Note that
  `jobs.<id>.environment` cannot read the `env` context, so the name must be the inline expression
  `${{ inputs.environment || 'staging' }}`.
- **The trigger inverts.** Push to `main` deploys **web and worker to staging** — the worker can
  deploy freely there, since no user's in-flight analysis is at stake. Prod becomes dispatch-only
  for both services. That is the switchover: `deploy-worker`'s `if:` gains the push event for
  staging, and `deploy-web`'s prod path loses it.
- **`deploy/worker` becomes `deploy/<env>/<service>`**, four tags. The staging pair is what makes
  promotion mechanical: **a prod dispatch defaults its `sha` to `deploy/staging/<service>`**, so
  the default action is "ship what staging has been running," and naming a SHA explicitly is the
  rollback path. That is the soft version; the hard version — refusing any SHA staging never ran —
  is worth adding only if the soft one gets ignored.
- **Migrations run per environment**, staging first by construction, which turns staging into a
  real rehearsal for the one step that cannot be rolled back.
  [`deploy-migrations.md`](deploy-migrations.md)'s step needs no change at all: it reads
  `DB_CONNECTION_STRING` from secrets, and the Environment is what makes that name resolve to a
  different database. Its rollback gate — skip whenever a SHA was named — carries over unchanged.

*Rejected: a matrix over environments.* A matrix fans out to all of them at once. Promotion is
sequential and gated; that is the point of having two.

**Trap: do not put required reviewers on the prod Environment without changing the trigger model.**
A job waiting for approval holds its concurrency slot, and GitHub keeps only one queued run per
group — so a third push cancels the second while approval is pending. Use the Environment for
secret scoping, branch restriction, and deployment history first.

## Interaction with the rest of the design

- [`deploy-skew-hardening.md`](deploy-skew-hardening.md) gets *more* important, not less: staging
  makes deploy skew a thing you can rehearse, and its `PLATFORM_SHUTDOWN_GRACE_MS` check must be
  set per environment on the same service block as the platform's own grace.
- The one-image invariant is what this rests on. If a `PUBLIC_*` variable or an `$env/static/*`
  import ever appears, the artifact stops being promotable and staging silently starts testing
  different bytes than prod runs. Worth a comment where it would first be tempting.

## Verification

Promote a commit from staging to prod and confirm the provider reports **the same digest** in both
environments. That single check is the whole design: if the digests differ, something rebuilt, and
staging stopped being evidence about prod.
