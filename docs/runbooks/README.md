# Runbooks

Procedures done by hand in production, in a vendor's dashboard or from your own shell, for
whoever runs the app at GBD. A person runs each one; an AI agent may read or write them, but
never performs one. When an alert fires, its own rule says what firing means; then follow the logs
runbook.

## Where things are

GBD staff logins own every account below, and the contractor is a member. Plan tiers and what
they cost are in [`scripts/monthly_costs.py`](../../scripts/monthly_costs.py).

| Vendor | Entry page → what we have | What it holds |
| --- | --- | --- |
| GitHub | github.com → `GreenerByDefault/foodservice-insights` | The code; the `production` Environment, which holds every production credential; Actions, which deploys; the GHCR packages `web` and `worker` |
| DigitalOcean | cloud.digitalocean.com → GBD's team → Apps | `foodservice-insights-web` and `foodservice-insights-worker` |
| Supabase | supabase.com/dashboard → the production project | The database, Auth, Storage and Studio. Auth settings live only in this dashboard, and the write guard does not cover them ([`docs/architecture.md`](../architecture.md) § Supabase: database, auth, and blob store) |
| Grafana Cloud | grafana.com → GBD's stack | The folder Foodservice Insights, which every web deploy overwrites |
| Better Stack | betterstack.com → Telemetry | The one source both apps forward their logs to |
| OpenAI | platform.openai.com → the project the spend is tracked in | The worker's API key |
| Squarespace | GBD's domains | DNS |
| Google Workspace | GBD's | Staff mailboxes |

## The runbooks

- [Write to the database by hand](write-to-the-database-by-hand.md), past the write guard.
- [Review cache suggestions](review-cache-suggestions.md) in Supabase Studio.
- [Rotate a secret](rotate-a-secret.md) in the `production` Environment.

## Writing one

- **One procedure per file, and only what the code cannot say**: the dashboard path, the order,
  the trap. Link to the code or doc that holds a fact, never restate it, and copy no number.
- **The shape**: when you would do this, the steps, how you know it worked, and what to do if it
  did not. Five to thirty lines. Name the file for what the reader is trying to do, or what
  happened.
- **Run by a person.** Every shell line is one a person types, and a credential is pasted at a
  prompt, never on a command line.
- **The repo is public.** Name the vendor's entry page and the resource's name, never a deep link
  into an account, a credential, a connection string, a person's address, a stack hostname, or a
  project, team or app id.
- **Unresolved questions are `**Open:**` in the entry**, never guessed. Open each vendor page an
  entry names while writing it.
