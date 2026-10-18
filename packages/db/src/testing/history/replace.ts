import { sql } from 'kysely';
import type { DatabaseExecutor } from '../../schema.ts';
import { withTransaction } from '../../transactions.ts';
import {
  type InsertedSyntheticHistory,
  insertSyntheticHistory,
  SYNTHETIC_EMAIL_DOMAIN,
  SYNTHETIC_SLUG_PREFIX,
} from './insert.ts';

/** Swap the synthetic history for a fresh one, ending today, so running this twice leaves what
 * running it once does. Rows anyone made by hand, the placeholder identity included, are untouched.
 *
 * One transaction, under a lock, so two runs at once cannot interleave into two histories. */
export async function replaceSyntheticHistory(
  database: DatabaseExecutor,
): Promise<InsertedSyntheticHistory> {
  return await withTransaction(database, async (transaction) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('seed:history'))`.execute(transaction);

    // The cascade takes reports, attempts and uploads, and the user delete takes memberships.
    // Each leaves a tombstone, which would count the old history beside the new one, so those go
    // too, found through the ids the deletes return.
    const organizations = await transaction
      .deleteFrom('organization')
      .where('slug', 'like', `${SYNTHETIC_SLUG_PREFIX}%`)
      .returning('id')
      .execute();
    const users = await transaction
      .deleteFrom('auth.users')
      .where('email', 'like', `%@${SYNTHETIC_EMAIL_DOMAIN}`)
      .returning('id')
      .execute();

    if (organizations.length > 0) {
      const organizationIds = organizations.map(({ id }) => id);
      await sql`
        WITH reports AS (
          DELETE FROM metrics.purged_report
          WHERE organization_id = ANY(${organizationIds}::uuid[])
          RETURNING id
        )
        DELETE FROM metrics.purged_attempt WHERE report_id IN (SELECT id FROM reports)
      `.execute(transaction);
    }
    if (users.length > 0) {
      await sql`
        DELETE FROM metrics.purged_user WHERE id = ANY(${users.map(({ id }) => id)}::uuid[])
      `.execute(transaction);
    }

    return await insertSyntheticHistory(transaction);
  });
}
