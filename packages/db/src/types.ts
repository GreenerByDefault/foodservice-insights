import type { InputFileId } from './generated/public/InputFile.ts';
import type { RejectedUploadId } from './generated/public/RejectedUpload.ts';
import type { ReportId } from './generated/public/Report.ts';
import type { ResultFileId } from './generated/public/ResultFile.ts';
import { uuidV7 } from './uuid.ts';

export type { UsersId as UserId } from './generated/auth/Users.ts';
export type { AnalysisAttemptId } from './generated/public/AnalysisAttempt.ts';
export type { default as AnalysisAttemptStatus } from './generated/public/AnalysisAttemptStatus.ts';
export type { default as AnalysisFailureReason } from './generated/public/AnalysisFailureReason.ts';
export type { AuditEventId } from './generated/public/AuditEvent.ts';
export type { default as CountsBasis } from './generated/public/CountsBasis.ts';
export type { OrganizationId } from './generated/public/Organization.ts';
export type { OrganizationInviteId } from './generated/public/OrganizationInvite.ts';
export type { default as OrganizationInviteStatus } from './generated/public/OrganizationInviteStatus.ts';
export type { default as OrganizationRole } from './generated/public/OrganizationRole.ts';
export type { default as RejectedUploadReason } from './generated/public/RejectedUploadReason.ts';
export type { default as ResultFileKind } from './generated/public/ResultFileKind.ts';
export type { default as UnitSystem } from './generated/public/UnitSystem.ts';
export type { InputFileId, RejectedUploadId, ReportId, ResultFileId };

/** How many attempts a report may have, enforced by the `analysis_attempt_attempt_number_range`
 * CHECK constraint (`packages/db/public-schema.sql`). Mirrored here — not read from the DB — for the TS
 * call sites (route handlers, tests) that need the number without a query. */
export const MAX_ANALYSIS_ATTEMPTS = 5;

/** How long an organization's name may be, enforced by the `organization_name_length` CHECK
 * constraint (`packages/db/public-schema.sql`). Mirrored here, not read from the DB, for the
 * create/rename forms and their tests. */
export const MAX_ORGANIZATION_NAME_LENGTH = 100;

/** How long an organization's slug may be, enforced by the `organization_slug_length` CHECK
 * constraint (`packages/db/public-schema.sql`). Mirrored here, not read from the DB, for
 * `deriveOrganizationSlug` and its tests. */
export const MAX_ORGANIZATION_SLUG_LENGTH = 48;

/** What an organization's slug may look like, enforced by the `organization_slug_format` CHECK
 * constraint (`packages/db/public-schema.sql`): lowercase alphanumerics, hyphen-separated, no
 * leading, trailing, or doubled hyphen. Mirrored here, not read from the DB, for
 * `deriveOrganizationSlug`, `apps/web/src/params/slug.ts`, and their tests. */
export const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Slugs no organization may take, enforced by the `organization_slug_not_reserved` CHECK
 * constraint (`packages/db/public-schema.sql`) — every static directory under
 * `apps/web/src/routes/(app)/orgs/`, which SvelteKit routes ahead of the dynamic
 * `[organizationSlug=slug]` segment. A slug in this set would be a real route and so
 * unreachable as an organization. Mirrored here, not read from the DB, for the create endpoint
 * and its tests. */
export const RESERVED_ORGANIZATION_SLUGS = [
  'new',
  'all',
  'api',
  'create',
  'invites',
  'settings',
  'admin',
  'account',
] as const;

export function newInputFileId(): InputFileId {
  return crypto.randomUUID() as InputFileId;
}

export function newResultFileId(): ResultFileId {
  return crypto.randomUUID() as ResultFileId;
}

export function newReportId(): ReportId {
  return uuidV7() as ReportId;
}

export function newRejectedUploadId(): RejectedUploadId {
  return uuidV7() as RejectedUploadId;
}
