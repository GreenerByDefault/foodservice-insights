# App Platform specs

Each file here is one DigitalOcean App Platform app, described in full: `web.yaml` and
`worker.yaml`. They are separate apps because a deploy restarts every component of an app, and the
worker deploys only on demand (`ARCHITECTURE.md` § Worker deploys only on demand).

**Status:** nothing submits these yet. `.claude/plans/hosting-provider.md` wires up the deploy step.

- **The file is the app.** A deploy submits the whole spec, and App Platform replaces the app's
  spec with it, so a setting changed in the dashboard lasts only until the next deploy. Change it
  here.
- **Each `${NAME}` is filled in at deploy** from the `production` GitHub Environment's secrets and
  variables, and an unset or empty one fails the deploy before anything is submitted. A new
  placeholder therefore needs its value in the Environment first. It also rules out App
  Platform's own bindable variables, such as `${APP_URL}`.
- **The region is the one nearest the Supabase project**, in AWS `us-east-1`: every request,
  claim, and lease renewal is a round trip to the database.
- **`EMAIL_TRANSPORT=provider`** is a stub whose every send fails with an `EmailError`, until
  `.claude/plans/email-provider.md` wires up Postmark. `EMAIL_GBD_ADDRESS` is a stand-in until GBD
  names one.
