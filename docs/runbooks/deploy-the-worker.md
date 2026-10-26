# Deploy the worker

The web app deploys itself on every push to `main`, but the worker deploys only when someone
starts it by hand ([`docs/architecture.md`](../architecture.md) § Worker deploys only on demand).
Deploy the worker:

- after a change under `apps/worker/`, `python/`, `contract/` or `packages/` lands on `main` and
  the web app has deployed it;
- right away once the web app starts requiring a newer worker contract version (see
  architecture § Worker deploys only on demand). Until the worker catches up, new analyses wait in
  the queue instead of running;
- after [rotating a secret](rotate-a-secret.md) that the worker uses.

Deploying interrupts any analyses that are running. Each one gets a grace period to finish; one
that is still running when the grace period ends fails, and its user is asked to retry. So deploy
at a quiet time when you can.

## To deploy

1. Go to [Actions → Deploy](https://github.com/GreenerByDefault/foodservice-insights/actions/workflows/deploy.yml),
   click **Run workflow**, leave "Use workflow from" set to `main`, and run it.
2. Open the new run. Its "Show commits since the last worker deploy" step lists what is going out.
   The worker always deploys the commit the web app is running, which may be behind `main`. If the
   change you meant to ship is missing, the web app has not deployed it yet: wait for that push's
   Deploy run to finish, then start the worker deploy again.

## How you know it worked

The Deploy run you started finishes green. Then, in [Better Stack](https://telemetry.betterstack.com),
search the logs for the new worker's `Worker started` line. Its `workerGitSha` should match the
commit that the run deployed.

If a step fails, its comment in [`deploy.yml`](../../.github/workflows/deploy.yml) explains what
the failure means. A failed deploy leaves the old worker running, so fix the cause and start the
deploy again.
