/** What a test of a route handler needs before it can call one: an organization that exists in
 * the database, a blob store whose objects get cleaned up, and a request that looks like the
 * form's.
 *
 * Not a `.test.ts` file, so no runner picks it up.
 */

import type { Database, OrganizationId } from '@gbd/db';
import { insertOrganization, withRollback } from '@gbd/db/testing';
import { type BlobStore, deletePrefix, organizationPrefix } from '@gbd/storage';
import type { Transaction } from 'kysely';
import { FIELD } from '$lib/reports/submission';
import { database } from '../db.ts';
import type { Session } from '../session.ts';
import { blobStore } from '../storage.ts';

export type FileFixtures = {
  transaction: Transaction<Database>;
  store: BlobStore;
  organizationId: OrganizationId;
};

export type ReportFixtures = {
  transaction: Transaction<Database>;
  store: BlobStore;
  session: Session;
};

/** Run `fn` against a real organization, and undo everything it wrote.
 *
 * Two cleanups, because the two stores need different ones: `withRollback` for the rows, and a
 * prefix delete for the objects, which no transaction can reach.
 */
export async function withFileFixtures<T>(fn: (fixtures: FileFixtures) => Promise<T>): Promise<T> {
  return await withRollback(database(), async (transaction) => {
    const { organization } = await insertOrganization(transaction);

    try {
      return await fn({ transaction, store: blobStore(), organizationId: organization.id });
    } finally {
      await deletePrefix(blobStore(), organizationPrefix(organization.id));
    }
  });
}

/** Run `fn` against a real organization, and undo everything it wrote.
 *
 * Two cleanups, because the two stores need different ones: `withRollback` for the rows, and a
 * prefix delete for the objects, which no transaction can reach. `withTemporaryOrganization`
 * from `@gbd/storage/testing` is the wrong tool here — it invents an organization id that has no
 * row behind it, and these tests need one that foreign keys will accept.
 */
export async function withReportFixtures<T>(
  fn: (fixtures: ReportFixtures) => Promise<T>,
): Promise<T> {
  return await withRollback(database(), async (transaction) => {
    const { organization, admin } = await insertOrganization(transaction);
    const session: Session = {
      userId: admin.id,
      organization: { id: organization.id, name: organization.name, role: 'admin' },
    };

    try {
      return await fn({ transaction, store: blobStore(), session });
    } finally {
      await deletePrefix(blobStore(), organizationPrefix(organization.id));
    }
  });
}

/** A CSV of roughly `byteSize` bytes, with the header the product asks for. */
export function aCsv(byteSize = 0): string {
  const header = 'product name,date ordered,amount ordered\n';
  const row = 'beef mince,2026-01-05,12\n';
  const rows = Math.max(1, Math.ceil((byteSize - header.length) / row.length));
  return header + row.repeat(rows);
}

export type UploadOverrides = {
  name?: string | null;
  siteName?: string | null;
  countsBasis?: string | null;
  unitSystem?: string | null;
  monthlyCounts?: string | null;
  file?: File | null;
};

/** The multipart request the upload form sends, so a test can drive `POST` itself. */
export function createUploadRequest(overrides: UploadOverrides = {}): Request {
  const form = new FormData();
  const fields = {
    name: 'Q1 procurement',
    siteName: 'Main dining hall',
    countsBasis: 'people',
    unitSystem: 'lb',
    monthlyCounts: JSON.stringify({ '2026-01': 120, '2026-02': 135 }),
    ...overrides,
  };

  for (const key of ['name', 'siteName', 'countsBasis', 'unitSystem', 'monthlyCounts'] as const) {
    const value = fields[key];
    if (value !== null && value !== undefined) form.set(FIELD[key], value);
  }

  const file =
    overrides.file === undefined
      ? new File([aCsv()], 'procurement.csv', { type: 'text/csv' })
      : overrides.file;
  if (file) form.set(FIELD.file, file);

  return new Request('http://localhost/api/reports', { method: 'POST', body: form });
}
