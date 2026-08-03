# Database schema

> **Status: build spec.** No migrations exist yet, so this file is the spec to build from. Once
> `packages/db/migrations/` exists, **those migrations are the source of truth for the schema** —
> not this file, and not the Supabase CLI's own `migrations/`, which we do not use. At that point,
> trim the column tables below to the model overview and let the migrations carry the detail.
>
> The [Invariants](#invariants) section outlives the trim: each entry becomes a test in
> `packages/db/tests/`, because an invariant encoded as a test cannot go stale silently.

For how the database fits into the wider system, see [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## The model

A **`report`** is one accepted upload. It has exactly one **`input_file`** and one or more
**`analysis_attempt`** rows; a retry is a new attempt, not a mutation of the old one. A successful
attempt produces **`result_file`** rows — one PDF, one XLSX, and a set of charts.

```
report ──1:1── input_file
   │
   └──1:N── analysis_attempt ──1:N── result_file
```

An upload that fails validation never becomes a report. It is recorded as a **`rejected_upload`**
instead, for debugging only.

Users, organizations, membership, and invites are the auth side of the schema; **`audit_events`**
is an append-only trail across everything.

Reasoning that outlives the column definitions:

- **`input_file` is its own table, not columns on `report`,** because files are exposed publicly
  through a `/file/:id` route. A file needs its own identifier to be addressable.
- **`audit_events` has no foreign keys.** Users and organizations can be hard-deleted, but their
  IDs must survive in the audit trail. Foreign keys would either block the delete or erase the
  evidence.
- **`organization_member`'s primary key is `(user_id, organization_id)`, in that order.** The
  common query is "which orgs does this user belong to", which needs `user_id` first. The reverse
  query — an admin listing org members — gets its own index.
- **`rejected_upload` uses `text` where `report` uses enums.** A rejected upload exists precisely
  because its input was invalid, so the table has to be able to store values that no enum permits.
- **Superadmin is a boolean on `app_user`, not a membership row.** See
  [`ARCHITECTURE.md`](../../ARCHITECTURE.md#auth).
- **The `analysis_attempt` status machine is the coordination point between the web app and the
  workers.** Its constraints and triggers are load-bearing concurrency control, not defensive
  decoration — several of them exist to make the reaping race described in
  [`ARCHITECTURE.md`](../../ARCHITECTURE.md#heartbeats-hangs-and-reaping) safe.

## Conventions

- **Every foreign key gets an index**, so rows are cleaned up quickly when the referenced row is
  deleted. The tables below leave these off; add them when implementing.
- **Every `checksum_sha256` gets `CHECK (octet_length(checksum_sha256) = 32)`.**
- **New queries get checked with `EXPLAIN ANALYZE`** before landing, per
  [Use The Index, Luke](https://use-the-index-luke.com) — this is what "queries are optimized" in
  [`REQUIREMENTS.md`](../../REQUIREMENTS.md#performance) means in practice.

## Tables

### `report`

| Column | Datatype | Required | On FK delete |
| --- | --- | --- | --- |
| `id` | uuid v7 (PK) | yes | — |
| `organization_id` | `organization.id` (FK) | yes | cascade |
| `created_by_user_id` | `app_user.id` (FK) | no | set null |
| `name` | text | no | — |
| `site_name` | text | no | — |
| `counts_basis` | enum (people, meals) | yes | — |
| `monthly_counts` | jsonb | yes | — |
| `unit_system` | enum (lb, kg) | yes | — |
| `created_at` | timestamptz | yes | — |
| `deleted_at` | timestamptz | no | — |
| `deleted_by_user_id` | `app_user.id` (FK) | no | set null |

- Index `(organization_id, created_at DESC)` for the reports list and abuse checks. The reports
  list then filters `WHERE deleted_at IS NULL`.
- Index `(created_by_user_id, created_at DESC)` for abuse checks.
- Check: `deleted_by_user_id IS NULL OR deleted_at IS NOT NULL`.

### `input_file`

One per `report`.

| Column | Datatype | Required | On FK delete |
| --- | --- | --- | --- |
| `id` | uuid v4 (PK) | yes | — |
| `report_id` | `report.id` (FK) | yes, unique | cascade |
| `storage_key` | text | yes, unique | — |
| `byte_size` | integer | yes | — |
| `content_type` | text | yes | — |
| `original_filename` | text | yes | — |
| `checksum_sha256` | bytea | yes | — |
| `created_at` | timestamptz | yes | — |

### `rejected_upload`

Not exposed publicly. Debugging only.

| Column | Datatype | Required | On FK delete |
| --- | --- | --- | --- |
| `id` | uuid v7 (PK) | yes | — |
| `organization_id` | `organization.id` (FK) | yes | cascade |
| `created_by_user_id` | `app_user.id` (FK) | no | set null |
| `report_name` | text | no | — |
| `report_site_name` | text | no | — |
| `report_counts_basis` | text | no | — |
| `report_monthly_counts` | jsonb | no | — |
| `report_unit_system` | text | no | — |
| `input_file_storage_key` | text | no | — |
| `input_file_byte_size` | integer | no | — |
| `input_file_original_filename` | text | no | — |
| `rejection_reason` | text, check in (invalid_metadata, too_large, bad_columns, unparseable, csv_injection, empty, other) | yes | — |
| `rejection_detail` | text | no | — |
| `created_at` | timestamptz | yes | — |

- Index `(organization_id, created_at DESC)`.

### `analysis_attempt`

A retry creates a new row.

| Column | Datatype | Required | On FK delete |
| --- | --- | --- | --- |
| `id` | uuid v7 (PK) | yes | — |
| `report_id` | `report.id` (FK) | yes | cascade |
| `attempt_number` | smallint | yes | — |
| `status` | enum (pending, processing, succeeded, failed, canceled) | yes | — |
| `requested_by_user_id` | `app_user.id` (FK) | no | set null |
| `created_at` | timestamptz | yes | — |
| `worker_id` | text | no | — |
| `locked_at` | timestamptz | no | — |
| `last_heartbeat_at` | timestamptz | no | — |
| `finished_at` | timestamptz | no | — |
| `cancel_requested_at` | timestamptz | no | — |
| `failure_reason` | text, check in (child_crashed, hung, hard_timeout, infrastructure, upstream_api, unknown) | no | — |
| `failure_detail` | text | no | — |
| `reaped_by_worker_id` | text | no | — |
| `ai_model` | text | no | — |
| `ai_input_tokens` | integer | no | — |
| `ai_output_tokens` | integer | no | — |
| `ai_cost_usd` | numeric(10,4) | no | — |
| `ai_metadata` | jsonb | no | — |
| `result_metadata` | jsonb | no | — |
| `notification_email_sent_at` | timestamptz | no | — |

Indexes:

- Queue: `(created_at) WHERE status = 'pending'`.
- Reaper: `(last_heartbeat_at) WHERE status = 'processing'`.
- Latest attempt for a report: `(report_id, attempt_number DESC)`.
- Unique `(report_id, attempt_number)`, so two workers cannot claim to be the same attempt.
- Unique `(report_id) WHERE status IN ('pending', 'processing')` — one active attempt per report.

**Open:** the AI metadata fields are a placeholder and may change. `result_metadata` will probably
be promoted to structured columns once its shape is scoped.

### `result_file`

Exposed publicly through the `/file/:id` route.

| Column | Datatype | Required | On FK delete |
| --- | --- | --- | --- |
| `id` | uuid v4 (PK) | yes | — |
| `analysis_attempt_id` | `analysis_attempt.id` (FK) | yes | cascade |
| `kind` | enum (pdf, xlsx, chart) | yes | — |
| `chart_key` | text | no | — |
| `storage_key` | text | yes, unique | — |
| `byte_size` | integer | yes | — |
| `content_type` | text | yes | — |
| `checksum_sha256` | bytea | yes | — |
| `created_at` | timestamptz | yes | — |

- `UNIQUE (analysis_attempt_id) WHERE kind = 'pdf'`
- `UNIQUE (analysis_attempt_id) WHERE kind = 'xlsx'`
- `UNIQUE (analysis_attempt_id, chart_key) WHERE kind = 'chart'`
- Index `analysis_attempt_id`.

**Open:** `kind = 'chart'` assumes the child process renders chart images that the web app
displays. If we render charts client-side with d3 instead, this table and the child's output
manifest both change shape.

### `app_user`

| Column | Datatype | Required |
| --- | --- | --- |
| `id` | uuid (PK, `= auth.users.id`, cascade on delete) | yes |
| `display_name` | text | no |
| `is_superadmin` | boolean | yes |
| `organizations_created_count` | integer | yes |
| `updated_at` | timestamptz | yes |

- The row is auto-created when `auth.users` gets a new row.
- Email and `created_at` live in `auth.users`.

### `organization`

| Column | Datatype | Required | On FK delete |
| --- | --- | --- | --- |
| `id` | uuid v7 (PK) | yes | — |
| `name` | text | yes, unique | — |
| `created_by_user_id` | `app_user.id` (FK) | no | set null |
| `created_at` | timestamptz | yes | — |
| `updated_at` | timestamptz | yes | — |

### `organization_member`

| Column | Datatype | Required | On FK delete |
| --- | --- | --- | --- |
| `user_id` | `app_user.id` (FK, PK) | yes | cascade |
| `organization_id` | `organization.id` (FK, PK) | yes | cascade |
| `role` | enum (member, admin) | yes | — |
| `joined_at` | timestamptz | yes | — |
| `updated_at` | timestamptz | yes | — |

- Primary key is `(user_id, organization_id)`; see [The model](#the-model) for why the order
  matters.
- Index `(organization_id, user_id)` so admins can list org members.

### `organization_invite`

| Column | Datatype | Required | On FK delete |
| --- | --- | --- | --- |
| `id` | uuid v7 (PK) | yes | — |
| `organization_id` | `organization.id` (FK) | yes | cascade |
| `email` | citext | yes | — |
| `role` | enum (member, admin) | yes | — |
| `invited_by_user_id` | `app_user.id` (FK) | no | set null |
| `created_at` | timestamptz | yes | — |
| `updated_at` | timestamptz | yes | — |
| `expires_at` | timestamptz | yes | — |
| `status` | enum (pending, accepted, declined, revoked, expired) | yes | — |

- Unique `(organization_id, email) WHERE status = 'pending'` — only one live invite at a time.
- Index `(email) WHERE status = 'pending'` for the login-time invite lookup.
- Index `(organization_id, created_at DESC)` for the hourly invite limit.
- `status` becomes `expired` lazily, not on a cron schedule:
  - An admin re-sending an invite expires the prior invite, then inserts a new row.
  - A user opening an expired invite causes the server to mark it expired, and to tell the user.

### `audit_events`

Not user-visible. Debugging and security audit trail only.

| Column | Datatype | Required |
| --- | --- | --- |
| `id` | bigint (PK) | yes |
| `occurred_at` | timestamptz | yes |
| `action` | text, e.g. `report.deleted` | yes |
| `actor_user_id` | uuid | no |
| `actor_kind` | enum (user, superadmin, system, gbd_manual) | yes |
| `organization_id` | uuid | no |
| `target_type` | text (report, organization, membership, invite, user) | no |
| `target_id` | uuid | no |
| `detail` | jsonb | no |

- No foreign keys — see [The model](#the-model).
- Index `(organization_id, occurred_at DESC)`.
- Make it append-only if we can revoke `UPDATE` and `DELETE` on the table.

## Invariants

These are correctness rules encoded in SQL. Nothing else in the stack catches a regression in
them, so **each one needs a test in `packages/db/tests/` asserting the database rejects the
violation.** That test, not the prose here, is the durable artifact.

### `analysis_attempt` status machine

- **One active attempt per report:** unique index on `(report_id) WHERE status IN ('pending',
  'processing')`.
- **New attempts only after failure:** a trigger permits a new row for a `report_id` only if it is
  the first attempt, or the latest `attempt_number` has `status = 'failed'`.
- **Terminal states are final:** a trigger rejects any update once `status` is terminal, except to
  `notification_email_sent_at`.
- **Pending:** if `status = 'pending'` then `worker_id IS NULL AND locked_at IS NULL`.
- **Processing:** if `status = 'processing'` then `worker_id IS NOT NULL AND locked_at IS NOT NULL
  AND last_heartbeat_at IS NOT NULL AND finished_at IS NULL`.
- **Terminal:** if `status` is terminal then `finished_at IS NOT NULL`; otherwise it is null.
- **Timestamp ordering:** `finished_at >= last_heartbeat_at >= locked_at >= created_at`, handling
  nulls (e.g. `finished_at IS NULL OR finished_at >= last_heartbeat_at`).
- **Attempt count:** `attempt_number` between 1 and 5, matching the retry abuse limit in
  [`REQUIREMENTS.md`](../../REQUIREMENTS.md#abuse-limits).
- **Failure reason:** `failure_reason IS NOT NULL` if and only if `status = 'failed'`.

Test the queue-claiming query under concurrency too — `FOR UPDATE SKIP LOCKED` handing the same
attempt to two workers is the failure this schema exists to prevent.

### Other tables

- **Every org keeps an admin:** a deferred trigger constraint on `organization_member` enforcing
  at least one admin per organization, as long as the organization still exists. Deferred, so that
  a promote-then-demote inside one transaction is legal.
- **`report` deletion audit:** `deleted_by_user_id IS NULL OR deleted_at IS NOT NULL`.
- **`result_file` chart keys:** `chart_key IS NOT NULL` if and only if `kind = 'chart'`.
- **`result_file` uniqueness:** one PDF and one XLSX per attempt, and no duplicate `chart_key`
  within an attempt.
- **Checksums are 32 bytes:** `octet_length(checksum_sha256) = 32`.
