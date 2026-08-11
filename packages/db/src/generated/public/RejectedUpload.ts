import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { UsersId as auth_UsersId } from '../auth/Users.js';
import type { OrganizationId } from './Organization.js';
import type { default as RejectedUploadReason } from './RejectedUploadReason.js';

/** Identifier type for public.rejected_upload */
export type RejectedUploadId = string & { __brand: 'public.rejected_upload' };

/**
 * Represents the table public.rejected_upload
 * An upload that failed validation and never became a report.
 */
export default interface RejectedUploadTable {
  id: ColumnType<RejectedUploadId, RejectedUploadId | undefined, RejectedUploadId>;

  organizationId: ColumnType<OrganizationId, OrganizationId, OrganizationId>;

  createdByUserId: ColumnType<auth_UsersId | null, auth_UsersId | null, auth_UsersId | null>;

  reportName: ColumnType<string | null, string | null, string | null>;

  reportSiteName: ColumnType<string | null, string | null, string | null>;

  reportCountsBasis: ColumnType<string | null, string | null, string | null>;

  reportMonthlyCounts: ColumnType<string | null, string | null, string | null>;

  reportUnitSystem: ColumnType<string | null, string | null, string | null>;

  inputFileStorageKey: ColumnType<string | null, string | null, string | null>;

  inputFileByteSize: ColumnType<number | null, number | null, number | null>;

  inputFileOriginalFilename: ColumnType<string | null, string | null, string | null>;

  rejectionReason: ColumnType<RejectedUploadReason, RejectedUploadReason, RejectedUploadReason>;

  rejectionDetail: ColumnType<string | null, string | null, string | null>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type RejectedUpload = Selectable<RejectedUploadTable>;

export type NewRejectedUpload = Insertable<RejectedUploadTable>;

export type RejectedUploadUpdate = Updateable<RejectedUploadTable>;
