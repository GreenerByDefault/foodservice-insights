import { newInputFileId } from '@gbd/db';
import { insertReport } from '@gbd/db/testing';
import { listObjectKeys, organizationPrefix, putInputFile } from '@gbd/storage';
import { describe, expect, test } from 'vitest';
import { withFileFixtures } from '$lib/server/tests/fixtures';
import { organizationAuditEvents } from '$lib/server/tests/organization-audit';
import { _deleteOrganization } from './+server.ts';

const CSV = new TextEncoder().encode('product name,date ordered,weight\n');

describe('_deleteOrganization', () => {
  test('deletes the organization row', async () => {
    await withFileFixtures(async ({ transaction, organizationId, adminUserId }) => {
      await _deleteOrganization(transaction, {
        organizationId,
        actor: { userId: adminUserId, role: 'admin' },
        actorEmail: 'admin@example.test',
      });

      const remaining = await transaction
        .selectFrom('organization')
        .select('id')
        .where('id', '=', organizationId)
        .executeTakeFirst();
      expect(remaining).toBeUndefined();
    });
  });

  test("empties the organization's blob prefix", async () => {
    await withFileFixtures(async ({ transaction, store, organizationId, adminUserId }) => {
      const report = await insertReport(transaction, { organizationId });
      await putInputFile(
        store,
        { organizationId, reportId: report.id, inputFileId: newInputFileId() },
        { original: CSV, normalized: CSV },
      );
      expect(await listObjectKeys(store, organizationPrefix(organizationId))).not.toEqual([]);

      await _deleteOrganization(transaction, {
        organizationId,
        actor: { userId: adminUserId, role: 'admin' },
        actorEmail: 'admin@example.test',
      });

      expect(await listObjectKeys(store, organizationPrefix(organizationId))).toEqual([]);
    });
  });

  test('writes an organization.deleted audit event that survives the organization it describes', async () => {
    await withFileFixtures(async ({ transaction, organizationId, adminUserId }) => {
      await _deleteOrganization(transaction, {
        organizationId,
        actor: { userId: adminUserId, role: 'admin' },
        actorEmail: 'admin@example.test',
      });

      expect(await organizationAuditEvents(transaction, organizationId)).toEqual([
        {
          action: 'organization.deleted',
          actorUserId: adminUserId,
          actorKind: 'user',
          organizationId,
          targetType: 'organization',
          targetId: organizationId,
        },
      ]);
    });
  });
});
