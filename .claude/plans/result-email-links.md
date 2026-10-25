# Result emails link to the report by slug

## Context

Found by the end-of-phase audit (2026-10-21), which was not looking for bugs:

- `packages/email/src/messages/links.ts:20-26` builds the report link as
  `/orgs/${organizationId}/reports/${reportId}`, and `messages/analysis.ts:20,30` carries an
  `organizationId: OrganizationId` on both `AnalysisSucceeded` and `AnalysisFailed`.
- The worker fills it from `report.organizationId`, a UUID
  (`apps/worker/src/sweeps/notifications.ts:203,217,330,340`).
- The page route has been `(app)/orgs/[organizationSlug=slug]/reports/[reportId=uuid]` since
  #293 (2026-09-07). The `slug` matcher (`apps/web/src/params.ts`) accepts a lowercase UUID, so
  the request reaches `requireOrganizationAccess` (`lib/server/auth/guards.ts:36-66`), which
  resolves by slug and answers 404. Every "report is ready" and "analysis failed" email since
  then has linked to a 404.
- Nothing catches it: `links.test.ts:13` still names the route `[organizationId]`, the system
  e2e (`tests/e2e/specs/report-lifecycle.e2e.ts:111-114`) matches the email's subject only, and
  the web e2e suite has no worker so never receives this email.
- Production is unaffected today: both `.do` specs set `EMAIL_TRANSPORT=provider`, the stub that
  drops every send. [`email-provider.md`](email-provider.md) PR 1 switches that to Postmark.

## Decisions

- **Land this before `email-provider.md` PR 1.** [`production-sign-in.md`](production-sign-in.md)
  § Order of operations places it.
- **Carry the slug, not both.** The messages gain `organizationSlug: string` in place of
  `organizationId`; the email never needed the id. The worker's notification query joins
  `organization` for `slug`. *Rejected: resolving the slug in the web app from an id.* It would
  add a redirect route to serve one link, and the id is not what any other URL carries.
- **The test that would have caught it is at the integration point**, as AGENTS.md § Testing
  philosophy asks: the system e2e follows the emailed link and lands on the report page.
- **`links.ts` stays separate from `apps/web/src/lib/hrefs.ts`.** Its header promises to move
  "when the web app grows a shared route module"; it has (`hrefs.ts`, 25 builders), but `@gbd/email`
  cannot depend on the app, and moving three builders into `@gbd/core` would split one route's
  composition across packages for a drift that types would not catch anyway (slug and id are both
  `string`). The header says instead that `hrefs.ts` is the source of truth, these three are
  rebuilt here because an email has no app to import from, and the e2e assertion is the guard.

## PR 1 — Slug in the message, and the e2e follows the link

- `packages/email/src/messages/analysis.ts`, `links.ts`: `organizationSlug`; `reportUrl(context,
  organizationSlug, reportId)`; the header as decided; `links.test.ts` names the real directories.
- `packages/email/src/testing/fixtures.ts`: `SAMPLE_ORGANIZATION_ID` becomes a slug sample
  (`notifications.test.ts`, `analysis.test.ts`, `render.test.ts` follow).
- `apps/worker/src/sweeps/notifications.ts`: join `organization`, select `slug`, pass it.
- `tests/e2e/specs/report-lifecycle.e2e.ts`: after the subject match, read the message, `goto`
  its report link, expect the report heading. (`readMailbox` already returns the body.)
- Delete this plan, and its step in `production-sign-in.md` § Order of operations.

## Verification

`pnpm lint && pnpm check && pnpm test`, then `pnpm test:system` (the one tier that covers the
seam, per `.claude/rules/typescript.md`). The new e2e assertion must fail on `main` before the
fix and pass after. Locally, upload through `pnpm dev` and click the link in Mailpit.
