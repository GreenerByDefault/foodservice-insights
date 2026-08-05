import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';

/** Identifier type for auth.instances */
export type InstancesId = string & { __brand: 'auth.instances' };

/**
 * Represents the table auth.instances
 * Auth: Manages users across multiple sites.
 */
export default interface InstancesTable {
  id: ColumnType<InstancesId, InstancesId, InstancesId>;

  uuid: ColumnType<string | null, string | null, string | null>;

  rawBaseConfig: ColumnType<string | null, string | null, string | null>;

  createdAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  updatedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export type Instances = Selectable<InstancesTable>;

export type NewInstances = Insertable<InstancesTable>;

export type InstancesUpdate = Updateable<InstancesTable>;
