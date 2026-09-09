import { newInputFileId } from '@gbd/db';
import { insertReport } from '@gbd/db/testing';
import { listObjectKeys, organizationPrefix, putInputFile } from '@gbd/storage';
import { describe, expect, test, vi } from 'vitest';
import { auditEventsFor, expectedAuditEvent } from '$lib/server/testing/audit';
import { mockUnreachableEmailer, withOrganizationFixtures } from '$lib/server/testing/fixtures';
import { _deleteOrganization } from './+server.ts';

const CSV = new TextEncoder().encode('product name,date ordered,weight\n');

vi.mock('$lib/server/email', (importOriginal) => mockUnreachableEmailer(importOriginal));

describe('_deleteOrganization', () => {
  test('deletes the organization row', async () => {
    await withOrganizationFixtures(async ({ transaction, organizationId, adminUserId }) => {
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
    await withOrganizationFixtures(async ({ transaction, store, organizationId, adminUserId }) => {
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
    await withOrganizationFixtures(async ({ transaction, organizationId, adminUserId }) => {
      await _deleteOrganization(transaction, {
        organizationId,
        actor: { userId: adminUserId, role: 'admin' },
        actorEmail: 'admin@example.test',
      });

      expect(await auditEventsFor(transaction, organizationId)).toEqual([
        expectedAuditEvent({
          action: 'organization.deleted',
          actorUserId: adminUserId,
          organizationId,
        }),
      ]);
    });
  });

  // The notification is best effort, and this is the only thing holding that: `notifyGbd` uses
  // an unreachable emailer in every test in this file (see the mock above), so a passing suite
  // here already proves the organization survives that failure.
  test('still deletes the organization when the GBD notice fails to send', async () => {
    await withOrganizationFixtures(async ({ transaction, organizationId, adminUserId }) => {
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
});
