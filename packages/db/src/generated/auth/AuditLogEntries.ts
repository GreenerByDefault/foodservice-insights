import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';

/** Identifier type for auth.audit_log_entries */
export type AuditLogEntriesId = string & { __brand: 'auth.audit_log_entries' };

/**
 * Represents the table auth.audit_log_entries
 * Auth: Audit trail for user actions.
 */
export default interface AuditLogEntriesTable {
  id: ColumnType<AuditLogEntriesId, AuditLogEntriesId, AuditLogEntriesId>;

  instanceId: ColumnType<string | null, string | null, string | null>;

  payload: ColumnType<unknown | null, unknown | null, unknown | null>;

  createdAt: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export type AuditLogEntries = Selectable<AuditLogEntriesTable>;

export type NewAuditLogEntries = Insertable<AuditLogEntriesTable>;

export type AuditLogEntriesUpdate = Updateable<AuditLogEntriesTable>;
