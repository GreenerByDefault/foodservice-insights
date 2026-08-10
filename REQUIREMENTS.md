# Requirements

What the product must do. For *how* it is built and why, see
[`ARCHITECTURE.md`](ARCHITECTURE.md).

This file is the source of truth for product rules, including the numeric limits. When
implementing, each value should live in exactly one place in code and be referenced from there, then replace these docs with a link to them. See [`AGENTS.md`](AGENTS.md#documentation).

## Product capabilities

### File upload

A user can upload a CSV or XLSX file matching a predefined column format.

- Single sheet with these columns:
  - product name: text
  - date ordered: date
  - amount ordered: number
- The website provides clear instructions for the file format.
- Max file size: [`packages/upload/src/limits.ts`](packages/upload/src/limits.ts).
- The user provides additional metadata:
  - a map of each month to the number of diners or meals
  - site name (optional)
  - lb vs kg
  - a name for the report, to help users identify it

**Open:** the report name may be unnecessary, or may overlap too much with site name. Drop it if
that proves true in the UI.

### Processing

The server sends requests to a Python worker that runs the existing AI library to process the
data and generate a PDF and an XLSX file.

### Errors during upload and processing

- **Upload issues:** the app indicates there was a problem and lets the user try again.
- **Invalid files** are rejected with a clear error.
  - Catch errors as early as feasible — a client-side check gives better UX, but the server must
    still validate for security.
  - Rejected files are kept in the blob store.
- **Internal errors:**
  - The user can retry a failed attempt without re-uploading the file or re-entering metadata.
  - The server allows only one retry at a time per report.
  - The error message makes clear this was not a problem with their file, and that retrying may
    help.

### Persistence

The input file and result files are stored in a blob store, with associated metadata in the
database.

- **Input metadata:** uploader, name, upload time, file size.
- **Result metadata:** file size, processing time, and AI metadata (number of tokens, model).
  - **Open:** the full result metadata shape depends on the JSON output from the AI library,
    which still needs to be reviewed.
- Input and result files are accessible to anyone with the link. The app only shows links to
  people with access, and links are hard to guess.
  - *Rejected: presigned URLs that expire after n minutes.* They add complexity and worsen UX —
    users are frustrated when a download link stops working, or when they forward an email to a
    coworker and the link fails. The data is not confidential enough to justify it.

### Analysis loading UX

The user sees the result in the web app within 30 seconds of the worker completing its analysis,
targeting 15 seconds.

- While waiting, the user sees a timeline of key events and a loading state naming the current
  stage: file upload / validation, waiting in queue, analyzing.
- The UI warns when a stage takes longer than expected.
- The user can cancel the request. This essentially soft-deletes the report — in-flight requests get a
  cancel button rather than a delete button.

### Result page

Buttons to download the input file, the result PDF, and the result Excel sheet, plus roughly 8
rendered charts and potentially some metadata.

### User email

The user receives an email when the analysis completes.

- Success includes links to download the result files, and potentially metadata.
- Failure explains the failure and links to the web app to retry.
- Email typically sends within 30 seconds, but is best effort. Delivery is not guaranteed.

### Multiple reports

A user can see historical reports, sorted by upload date. Additional requests can be submitted
while an analysis is still running.

### Landing page

A marketing page when signed out. The GBD comms person will provide language and design in the future.

## Auth

### Users and organizations

A **user** is an individual human. Humans must not share an account.

A user can belong to one or more **organizations**; an organization has one or more users. The
UI has an organization switcher when a user belongs to more than one.

**Reports belong to organizations, not users.** When a user joins an organization, they can
access all of its reports. There is no per-file ACL — that would be substantially more complex.

- When uploading a new report, the UI makes it very clear which organization it belongs to.

### Roles

Within each org, a user has a role. Admins have every member permission plus the rest:

| Permission | member | admin |
| --- | :---: | :---: |
| Upload a new report | ✅ | ✅ |
| Read all org reports | ✅ | ✅ |
| Delete their own reports | ✅ | ✅ |
| Leave an organization | ✅ | ✅ |
| Create a new organization | ✅ | ✅ |
| Rename themself | ✅ | ✅ |
| Change their email | ✅ | ✅ |
| Delete their account | ✅ | ✅ |
| Delete any report in the org | — | ✅ |
| Invite a new user to the org | — | ✅ |
| Remove a user from the org | — | ✅ |
| Promote a member to admin | — | ✅ |
| Demote an admin to member | — | ✅ |
| Rename the organization | — | ✅ |
| Delete the organization | — | ✅ |

An org must always have at least one admin. The app does not permit an admin to take any action
that would violate this.

### Superadmin

Users are manually set to superadmin in the Supabase web UI. Superadmins are automatically
admins for *all* organizations.

- The UI does not show the superadmin in an organization's membership management.
- The superadmin does not count toward the one-admin-per-org invariant.
- The superadmin sees all orgs in the org switcher.

### GBD email notifications

The configured GBD email address is notified whenever an organization is created, a user is
deleted, or an organization is deleted.

### Authentication mechanism

Email OTP (one-time passcode).

- *Rejected: email magic link.* Annoying across devices.
- *Rejected: passwords.* Insecure given password reuse, and they encourage org members to share
  one account. They also need email infrastructure comparable to OTP anyway, for resets.
- *Rejected: social sign-on.* Too complex to integrate for now, and there is no obvious account
  provider for business accounts.
- *Rejected: passkeys.* Too complex for now.

### Invite flow

- An admin invites someone by email address and assigns their role. The invitee does not need an
  existing account.
- The invitee gets an email linking to the site, with their email pre-filled. No magic token. They
  log in with OTP as normal.
- On login, the server checks for pending invites matching the user's email:
  - Invites still within `expires_at` are shown on an accept/decline screen.
  - Invites past `expires_at` transition to expired at that moment, and the user sees a one-time
    notice.
- Only the person who controls the invited email address can accept. Forwarding the link does
  not grant access.
- Invites expire after 14 days. An admin can revoke a pending invite at any time.
- An admin can re-invite an address that already has an invite outstanding. That sends a fresh
  email and restarts the 14 days with a new invite.

### Login flow

After OTP verification, where the user lands (a live invite, an org, the org picker, or
`/orgs/new`) is decided by
[`_resolvePostSignInDestination`](apps/web/src/routes/(app)/orgs/+page.server.ts). The invite
branch's own behavior — accept/decline, the one-time expiry notice — is the Invite flow section
above.

### Audit trail

Authentication and audit events are logged in the database: report deletion, organization
deletion, invites, membership changes, and role changes. Logins are *not* recorded — too noisy.

### Data deletion

- The roles table above governs what members and admins may delete.
- **Deleting a report** removes it from the UI and makes its file links inaccessible, but does
  not delete any data. We keep everything for debugging.
- **A user deleting their account** hard-deletes the user, but does *not* delete that member's
  reports in the organization.
  - The app displays the submitter as a deleted user.
  - The raw user ID stays in the audit log.
- **An admin is blocked** from deleting their account, or leaving an organization, until they
  either delete the whole organization or promote another admin.
- **An admin deleting an organization** *does* hard-delete all of the organization's reports and input files. It
  does not delete any user accounts.
- A user can email GBD to request a hard delete. GBD admins do it with a script or in the
  Supabase UI (TBD which approach).

### Account recovery

A user who needs to change their email but is locked out of the original must contact GBD, who
verifies them and then changes the email with a script or in the Supabase UI (TBD which approach).

## Non-functional

### Product categorization cache

The AI code uses a cache of product categorizations from earlier runs. New runs add to the cache,
but **new entries go through human review first.**

### Design and accessibility

Follow GBD design and accessibility standards.

- Responsive web: works well on mobile, tablet, and desktop.
- Passes accessibility review by GBD staff.

### Security

Follow security best practices for web development.

- Input files are handled according to their risk, such as Excel zip bombs and CSV injection.
- Always use minimum permissions — for example, read-only database access when debugging.
- Data is encrypted in transit and at rest.
- Protect against prompt injection.
- Regularly audit and patch dependencies.
- Implement a Content Security Policy (CSP).
- Enforce HTTPS via HTTP Strict Transport Security (HSTS).
- Implement CSRF protection tokens.
- Sanitize and encode user inputs to prevent XSS.
- Configure secure cookie attributes (`HttpOnly`, `Secure`, `SameSite`).

### Abuse limits

- Payload limits.
- Server-side form validation.
- **Org creation:** a user can create up to 5 organizations.
- **Hourly reports:** 5 valid reports per hour, enforced per organization *and* per user.
- **Weekly reports:** 20 valid reports per 7 rolling days, per organization *and* per user.
- **Report retries:** a report can be attempted up to 5 times. (Retries exist for internal
  errors.)
- **Invites:** an organization can invite 5 users per hour.
- Cloudflare for DDoS protection, and potentially geo-restrictions.

### Performance

- The system handles roughly 3–5 concurrent requests. This number may be adjusted later.
- A single request without queue time usually takes about 5 minutes, ranging from 2–15 minutes.
  The slowness is almost entirely the AI tool.
- The web server is stateless, so horizontal scaling can be added later.
- Workers can be scaled horizontally and vertically.
  - *Rejected for now: autoscaling.* It would have to key off queue depth rather than CPU
    utilization, which implies a much more complex hosting vendor (Google Cloud rather than
    Railway or Render). The system should be designed so autoscaling can be added later.
- Database queries are optimized.

### Resilience

- Set timeouts for all requests.
- Use retries where appropriate.
- Handle distributed-system risks such as zombie connections.

See [`ARCHITECTURE.md`](ARCHITECTURE.md#failure-modes) for the failure-mode inventory.

### Metrics

- Number of users over time.
- Number of reports over time.
- Analysis attempt time: time in queue, time to process, total.
- Analysis cost, via AI metrics.
- Number of failed analysis attempts.
- Country of users, via the Cloudflare dashboard.

### Maintainability

- CI and CD.
- Good local development workflow.
- High test coverage.
- Linters, type checkers, formatters.
- Clear documentation, including architecture.
- Staging environment.

### Observability

- Logging.
- Dashboards showing debugging metrics such as request durations and error counts.
- Alerts.

## Out of scope

Deliberate non-goals. These are as load-bearing as the requirements above — they mark work we
have decided *not* to do for now.

- **No batch upload.** Uploads are one file at a time.
- **No search for reports.**
- **No complex filtering of reports.**
- **No blocking of users or organizations.** It would only slow down someone malicious, and the
  risk is not worth the complexity for now.
- **No automated data cleanup.** The business rules already cover deleting files and metadata. If
  orphaned data turns up, cleanup can be added later.
- **No web-based notifications.**
- **No transferring a report to another organization.** A user who creates a report in the wrong
  organization recreates it in the right one.
- **No client-side metrics** such as Google Analytics. It would require a new service and a
  cookie policy.
  - Server-side metrics come from database queries for now. If we need events that the database
    does not capture, we would need a new service. Anonymous server-side metrics are easy to do
    without a cookie policy; only the service is missing.
- **No internationalization.**
