# Deploy pipeline in GitHub Actions

## Context

`ARCHITECTURE.md` § Deployments says to "decouple the web app deployment from the worker, so the
worker is not redeployed unnecessarily," because a worker redeploy destroys in-flight analysis
attempts — each 2–15 minutes of paid AI work. Nothing implements that yet: there is no deploy
workflow, and `.github/workflows/ci.yml` has no `workflow_dispatch`.

This shape is provider-independent, so it can be built before the provider is picked. All it asks of
a provider is a way to deploy one named service at a named commit and get back a real exit code.
Provider research is in [`hosting-provider-notes.md`](hosting-provider-notes.md).

## The model

**Both services deploy through one GitHub Actions workflow. The platform's own git integration is
off for both, so the platform never ships anything we did not ask for.**

| | Web | Worker |
| --- | --- | --- |
| Trigger | `push: main`, unfiltered | `workflow_dispatch`, naming a SHA |
| Migrations | yes, the platform's pre-deploy step | no |
| Rollback | dispatch at an older SHA | dispatch at an older SHA |

One workflow, two jobs, both calling the same composite step that deploys a service at a SHA. That
buys parity — one file to read, one gesture to roll back either service, one audit trail — and it
means "can this provider disable auto-deploy in committed config?" stops being a design constraint.

Three consequences worth writing down, because they are what make the model correct:

- **The web job is unfiltered: every push to `main` deploys it.** Filtering it is tempting and is a
  trap — a push touching only `apps/worker` plus a migration would deploy nothing, and the later
  manual worker deploy would run against an unmigrated database. Web deploys are stateless,
  health-checked and cheap; running one on every push is what guarantees a migration is applied
  before the worker deploy that needs it.
- **The worker is the component that lags, by construction.** Migrations first, web within minutes,
  worker whenever a human says so. The compatibility burden therefore sits in one place and points
  one way: *the deployed worker must keep working against the newest schema and the newest web app.*
  That is the invariant [`deploy-skew-hardening.md`](deploy-skew-hardening.md) defends and the one to
  test against.
- **Migrations stay the platform's pre-deploy step on the web service, not a workflow step.** Two
  reasons: on both services, two deploys race the same schema; and running them from a GitHub runner
  would put the production database credentials in GitHub secrets and require the database to accept
  connections from runners. Pre-deploy keeps them on the platform.

## Deliberately nothing clever in CI

**No staleness check, no `worker_deploy` path filter.** Two cases hide under "the worker needs
deploying" and they want opposite treatment:

- *Routine drift* — worker code changed, nothing needs it out today. No signal wanted; deploy when
  the queue is quiet.
- *A change that must go out* — rare, and the author already knows. With the contract-version guard
  in [`deploy-skew-hardening.md`](deploy-skew-hardening.md) they can express it in code: bump the
  version, and old workers stop claiming that work. The queue backs up and the alert
  `ARCHITECTURE.md` already commits to — "alert on attempts waiting too long to be claimed" — fires
  at a human, tied to real user impact.

So the signal that matters already exists, downstream of the thing that matters. A CI check would be
a second, worse copy of it, plus a hand-maintained filter list with an enforcement script attached,
reported somewhere nobody looks.

What the deploy workflow *does* do is print `git log deploy/worker..<sha> --oneline` when invoked —
the delta, at the moment someone is acting on it. The `deploy/worker` tag is force-moved on success
and costs nothing.

> If we ever do want a precise "does this need to go out?" answer, the tool is
> `turbo run build --filter='@gbd/worker...[deploy/worker]' --dry=json` — a non-empty task list means
> the worker's dependency closure changed, straight from the real graph rather than globs. Verified
> against this repo's history: `[HEAD~1]` and `[HEAD~5]` give an empty list, `[HEAD~20]` gives
> `@gbd/{core,db,email,storage,worker}`. Python and `contract/` sit outside that graph and would
> still need paths.

## Work

- `.github/workflows/deploy.yml`: a `push: main` job for web, a `workflow_dispatch` job taking a
  service and a SHA, both on one composite deploy step. Move `deploy/worker` on success and print the
  delta.
- Turn off the platform's git auto-deploy on both services at setup.
- `ARCHITECTURE.md` § Deployments gains the lag invariant.

The runbook — how to deploy, how to roll back, what to do when a migration is involved — belongs in
that workflow and its comments rather than a new doc, per *prefer documentation that executes*. A
root `DEPLOYMENT.md` only if that proves insufficient.

## Verification

The workflow's own logic can be exercised on a branch; the deploy trigger cannot be verified until an
account exists. Say so rather than implying otherwise.
