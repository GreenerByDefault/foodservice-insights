import type { RawBuilder } from 'kysely';
import type { AppUser } from '../../generated/public/AppUser.ts';
import type CountsBasis from '../../generated/public/CountsBasis.ts';
import type { InputFile } from '../../generated/public/InputFile.ts';
import type { Organization } from '../../generated/public/Organization.ts';
import type { Report } from '../../generated/public/Report.ts';
import type UnitSystem from '../../generated/public/UnitSystem.ts';
import type { DatabaseExecutor } from '../../schema.ts';
import { insertOrganization } from './organization.ts';
import { aChecksum } from './values.ts';

export async function insertReport(
  database: DatabaseExecutor,
  overrides: Partial<{
    organizationId: Organization['id'];
    createdByUserId: AppUser['id'] | null;
    name: string;
    siteName: string | null;
    countsBasis: CountsBasis | null;
    monthlyCounts: unknown;
    unitSystem: UnitSystem;
    createdAt: Date | RawBuilder<Date>;
  }> = {},
): Promise<Report> {
  const organizationId =
    overrides.organizationId ?? (await insertOrganization(database)).organization.id;

  return await database
    .insertInto('report')
    .values({
      organizationId,
      createdByUserId: overrides.createdByUserId ?? null,
      name: overrides.name ?? 'Q1 procurement',
      siteName: overrides.siteName ?? null,
      countsBasis: overrides.countsBasis === undefined ? 'people' : overrides.countsBasis,
      monthlyCounts:
        overrides.monthlyCounts === undefined
          ? { '2026-01': 120, '2026-02': 135 }
          : overrides.monthlyCounts,
      unitSystem: overrides.unitSystem ?? 'lb',
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function insertInputFile(
  database: DatabaseExecutor,
  overrides: {
    reportId?: Report['id'];
    storageKey?: string;
    object?: { byteSize: number; checksumSha256: Buffer };
    workbook?: { storageKey?: string; byteSize?: number; checksumSha256?: Buffer };
  } = {},
): Promise<InputFile> {
  const reportId = overrides.reportId ?? (await insertReport(database)).id;

  return await database
    .insertInto('inputFile')
    .values({
      reportId,
      storageKey: overrides.storageKey ?? `org/test/${crypto.randomUUID()}.csv`,
      byteSize: overrides.object?.byteSize ?? 1024,
      contentType: 'text/csv',
      originalFilename: 'procurement.csv',
      checksumSha256: overrides.object?.checksumSha256 ?? aChecksum(),
      isModified: false,
      ...(overrides.workbook && {
        workbookStorageKey: overrides.workbook.storageKey ?? `org/test/${crypto.randomUUID()}.xlsx`,
        workbookByteSize: overrides.workbook.byteSize ?? 2048,
        workbookChecksumSha256: overrides.workbook.checksumSha256 ?? aChecksum(),
      }),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
