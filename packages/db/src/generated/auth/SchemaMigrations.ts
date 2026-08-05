import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';

/** Identifier type for auth.schema_migrations */
export type SchemaMigrationsVersion = string & { __brand: 'auth.schema_migrations' };

/**
 * Represents the table auth.schema_migrations
 * Auth: Manages updates to the auth system.
 */
export default interface SchemaMigrationsTable {
  version: ColumnType<SchemaMigrationsVersion, SchemaMigrationsVersion, SchemaMigrationsVersion>;
}

export type SchemaMigrations = Selectable<SchemaMigrationsTable>;

export type NewSchemaMigrations = Insertable<SchemaMigrationsTable>;

export type SchemaMigrationsUpdate = Updateable<SchemaMigrationsTable>;
