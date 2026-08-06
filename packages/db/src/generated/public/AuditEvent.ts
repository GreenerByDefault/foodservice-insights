import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { default as AuditActorKind } from './AuditActorKind.js';

/** Identifier type for public.audit_event */
export type AuditEventId = string & { __brand: 'public.audit_event' };

/**
 * Represents the table public.audit_event
 * Append-only trail. Deliberately has no foreign keys: users and organizations can be hard-deleted, and their IDs must survive here. Not user-visible.
 */
export default interface AuditEventTable {
  id: ColumnType<AuditEventId, never, never>;

  occurredAt: ColumnType<Date, Date | string | undefined, Date | string>;

  action: ColumnType<string, string, string>;

  actorUserId: ColumnType<string | null, string | null, string | null>;

  actorKind: ColumnType<AuditActorKind, AuditActorKind, AuditActorKind>;

  organizationId: ColumnType<string | null, string | null, string | null>;

  targetType: ColumnType<string | null, string | null, string | null>;

  targetId: ColumnType<string | null, string | null, string | null>;

  detail: ColumnType<unknown | null, unknown | null, unknown | null>;
}

export type AuditEvent = Selectable<AuditEventTable>;

export type NewAuditEvent = Insertable<AuditEventTable>;

export type AuditEventUpdate = Updateable<AuditEventTable>;
