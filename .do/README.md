# App Platform specs

Each file here is one DigitalOcean App Platform app, described in full: `web.yaml` and
`worker.yaml`. They are separate apps because a deploy restarts every component of an app, and the
worker deploys only on demand (`ARCHITECTURE.md` § Worker deploys only on demand).

- **The file is the app.** A deploy submits the whole spec, and App Platform replaces the app's
  spec with it, so a setting changed in the dashboard lasts only until the next deploy. Change it
  here.
- **Each `${NAME}` is filled in at deploy** from the `production` GitHub Environment's secrets and
  variables, and an unset or empty one fails the deploy before anything is submitted. A new
  placeholder therefore needs its value in the Environment first. It also rules out App
  Platform's own bindable variables, such as `${APP_URL}`.
  *Rejected: committing DigitalOcean's encrypted `EV[…]` values,* which would give runtime
  secrets a second home, in a public repo.
- **To rotate a secret**, change it in the Environment and redeploy. The web redeploys on the next
  push to `main`; the worker only when you dispatch `deploy.yml`.
- **To roll back**, use the app's dashboard. A rollback restores that deployment's env too, so it
  undoes any secret rotated since. If the next deploy is refused because the rollback pinned the
  app, commit or revert the rollback in the dashboard.
- **The region is the one nearest the Supabase project**, in AWS `us-east-1`: every request,
  claim, and lease renewal is a round trip to the database.
- **`EMAIL_TRANSPORT=provider`** is a stub that drops every send as if it went out, until
  `.claude/plans/email-provider.md` wires up Postmark. `EMAIL_GBD_ADDRESS` is a stand-in until GBD
  names one.
