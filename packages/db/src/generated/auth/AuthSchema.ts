import type { default as AuditLogEntriesTable } from './AuditLogEntries.js';
import type { default as InstancesTable } from './Instances.js';
import type { default as RefreshTokensTable } from './RefreshTokens.js';
import type { default as SchemaMigrationsTable } from './SchemaMigrations.js';
import type { default as UsersTable } from './Users.js';

export default interface AuthSchema {
  users: UsersTable;

  refreshTokens: RefreshTokensTable;

  instances: InstancesTable;

  schemaMigrations: SchemaMigrationsTable;

  auditLogEntries: AuditLogEntriesTable;
}
