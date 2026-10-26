# Runbooks

Procedures that whoever runs the app at GBD does by hand in production, in a vendor's dashboard.
A person runs each one; an AI agent may read or write them but never performs one. When an alert
fires, its rule says what firing means; then follow the logs runbook.

## Where things are

A GBD staff login owns every account below, and the contractor is a member of each. Plan tiers
and their costs are in [`scripts/monthly_costs.py`](../../scripts/monthly_costs.py).

| Vendor | Go to | What it holds |
| --- | --- | --- |
| [GitHub](https://github.com/GreenerByDefault/foodservice-insights) | [Environments](https://github.com/GreenerByDefault/foodservice-insights/settings/environments), [Deploy](https://github.com/GreenerByDefault/foodservice-insights/actions/workflows/deploy.yml), [Packages](https://github.com/orgs/GreenerByDefault/packages?repo_name=foodservice-insights) | The code; the `production` Environment, which holds every production credential; Actions, which deploys; the GHCR packages `web` and `worker` |
| [DigitalOcean](https://cloud.digitalocean.com/apps) | GBD's team → Apps | `foodservice-insights-web` and `foodservice-insights-worker` |
| [Supabase](https://supabase.com/dashboard/projects) | The production project | The database, Auth, Storage and Studio. Auth settings live only in this dashboard, and the write guard does not cover them ([`docs/architecture.md`](../architecture.md) § Supabase: database, auth, and blob store) |
| [Grafana Cloud](https://grafana.com/auth/sign-in) | GBD's stack | The Foodservice Insights folder, which every web deploy overwrites |
| [Better Stack](https://telemetry.betterstack.com) | Telemetry | The one source both apps forward their logs to |
| [OpenAI](https://platform.openai.com/settings/organization/projects) | The project the spend is tracked in | The worker's API key |
| [Squarespace](https://account.squarespace.com/domains) | GBD's domain | DNS |
| [Google Workspace](https://admin.google.com) | GBD's organization | Staff mailboxes |

## The runbooks

- [Write to the database by hand](write-to-the-database-by-hand.md), past the write guard.
- [Review cache suggestions](review-cache-suggestions.md) in Supabase Studio.
- [Rotate a secret](rotate-a-secret.md) in the `production` Environment.
- [Deploy the worker](deploy-the-worker.md), the one deploy done by hand.

## Writing one

- **One procedure per file, and only what the code cannot say**: the dashboard path, the order,
  the trap. Link to the code or doc that holds a fact, never restate it, and copy no number.
- **The shape**: when you would do this, the steps, how you know it worked, and what to do if it
  did not. Name the file for what the reader is trying to do, or for what happened.
- **Use the vendor's dashboard, not its CLI**, so nobody has to install or sign in to a CLI to
  follow a runbook. Config as code belongs in the code, not in a runbook. Use a shell line only
  where no dashboard can do the step, and never put a credential on a command line.
- **The repo is public.** Link to GitHub freely, since everything there is as public as the repo.
  For any other vendor, link only its entry page and name the resource. Never include a deep link
  into an account, a credential, a connection string, a person's address, a stack hostname, or a
  project, team or app id.
- **Unresolved questions are `**Open:**` in the entry**, never guessed. Open each vendor page an
  entry names while writing it.
