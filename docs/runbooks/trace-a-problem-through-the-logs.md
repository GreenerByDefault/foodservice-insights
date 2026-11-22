# Trace a problem through the logs

Use this when a user reports that something broke, when an alert fires, or when a report failed
and its row does not say enough. Both apps' lines are in one source in
[Better Stack](https://telemetry.betterstack.com) → Telemetry → Live tail, in time order, and
`syslog.appname` says which app wrote each line.

Lines are kept only as long as the plan allows ([`scripts/monthly_costs.py`](../../scripts/monthly_costs.py)
names the tier). Older lines are gone, and the database row is all that is left.

## Find the line to start from

Pick the first case that fits, set Live tail's time range to cover it, and search for the field it
names. App fields sit under `message_json`, so a search looks like
`message_json.requestId=<id>`.

- **A report failed.** The report's id is in its URL. Search `message_json.reportId` to get every
  attempt's lines. To see why it failed without the logs, open
  [Supabase](https://supabase.com/dashboard/projects) → the production project → Table Editor →
  `analysis_attempt`, and filter on `report_id`. `failure_reason` and `failure_detail` are kept
  for good. The row's `id` is the `attemptId` on its lines.
- **A user saw an error page.** If they can give you the response's `X-Request-Id` header, search
  `message_json.requestId`. Otherwise, find their user id in Supabase → Authentication → Users
  by their email address. Then search `message_json.userId` around the time they give you.
- **An alert fired.** Open the Errors preset and read from the alert's time. The alert's own rule
  says what firing means.

## Read what happened

Open the line you found. Then search for its `requestId` or `attemptId` to see the lines around it.
An attempt's lines run from `Claimed an attempt`, through the child's exit, to
`Recorded the verdict`. A web request ends with its `Request` access line, which holds
`status`, `durationMs` and `routeId`.

Polls and health probes log at `debug`, below production's level, so they are not in the stream.
If a request you expected to find is missing, check that its route is not in `UNATTENDED_ROUTES`
in [`hooks.server.ts`](../../apps/web/src/hooks.server.ts).

## If you find nothing

- If a search returns nothing but the time range is right, you may have searched a field at the
  top level. Search it under `message_json`.
- Lines from before the retention window are gone. Use the row's `failure_reason` and
  `failure_detail`, and ask the user to tell you right away the next time it happens.
