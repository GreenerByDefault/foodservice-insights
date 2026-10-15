/** Writing a child's `telemetry.json` into the three telemetry tables.
 *
 * The rows carry the attempt, report and organization ids raw, with no foreign key to any of them,
 * so they outlive what they describe — `packages/db/README.md` has why. That also means the insert
 * touches no row another worker could own, which is what lets a parent that lost its attempt still
 * record what its child spent.
 */

import type {
  AnalysisAttemptId,
  CountsBasis,
  DatabaseExecutor,
  OrganizationId,
  ReportId,
} from '@gbd/db';
import { withTransaction } from '@gbd/db';
import type { Telemetry } from '../contract/messages.ts';

/** Who the telemetry describes. The child's document names none of it, so the parent supplies it. */
export type TelemetryIdentity = {
  attemptId: AnalysisAttemptId;
  reportId: ReportId;
  organizationId: OrganizationId;
  countsBasis: CountsBasis;
};

/** Insert all three tables in one transaction, so there are never half the facts. A retry after an
 * ambiguous commit finds the rows already there and changes nothing. */
export async function insertTelemetry(
  db: DatabaseExecutor,
  identity: TelemetryIdentity,
  telemetry: Telemetry,
): Promise<void> {
  await withTransaction(db, async (transaction) => {
    const inserted = await transaction
      .insertInto('analysisAttemptTelemetry')
      .values(telemetryRow(identity, telemetry))
      .onConflict((conflict) => conflict.column('analysisAttemptId').doNothing())
      .returning('analysisAttemptId')
      .executeTakeFirst();
    // Already recorded: the child rows went in with it, under the same transaction.
    if (inserted === undefined) return;

    const analysisAttemptId = identity.attemptId;
    if (telemetry.llmUsage.length > 0) {
      await transaction
        .insertInto('analysisAttemptLlmUsage')
        .values(telemetry.llmUsage.map((usage) => ({ ...usage, analysisAttemptId })))
        .execute();
    }
    const findingCounts = telemetry.report?.findingCounts ?? [];
    if (findingCounts.length > 0) {
      await transaction
        .insertInto('analysisAttemptQualityCheck')
        .values(findingCounts.map((findingCount) => ({ ...findingCount, analysisAttemptId })))
        .execute();
    }
  });
}

function telemetryRow(identity: TelemetryIdentity, telemetry: Telemetry) {
  const { input, categorization, report, stageDurationMs } = telemetry;
  return {
    analysisAttemptId: identity.attemptId,
    reportId: identity.reportId,
    organizationId: identity.organizationId,
    countsBasis: identity.countsBasis,

    inputRows: input?.rows ?? null,
    inputKilograms: input?.kilograms ?? null,
    inputUniqueProducts: input?.uniqueProducts ?? null,
    categorizationCacheEntries: input?.categorizationCacheEntries ?? null,

    cacheRawNameProducts: categorization?.cacheRawNameProducts ?? null,
    cacheCleanedNameProducts: categorization?.cacheCleanedNameProducts ?? null,
    llmMatchedProducts: categorization?.llmMatchedProducts ?? null,
    cacheNoMatchProducts: categorization?.cacheNoMatchProducts ?? null,
    llmNoMatchProducts: categorization?.llmNoMatchProducts ?? null,
    unrecognizedLlmAnswers: categorization?.unrecognizedLlmAnswers ?? null,
    categorizedRows: categorization?.categorizedRows ?? null,
    categorizedKilograms: categorization?.categorizedKilograms ?? null,

    totalCo2eKg: report?.totalCo2eKg ?? null,
    co2eKgPerDinerOrMeal: report?.co2eKgPerDinerOrMeal ?? null,
    plantPctByWeight: report?.plantPctByWeight ?? null,
    plantProteinPctByWeight: report?.plantProteinPctByWeight ?? null,

    readDurationMs: stageDurationMs.read ?? null,
    categorizeDurationMs: stageDurationMs.categorize ?? null,
    reportDurationMs: stageDurationMs.report ?? null,
    pdfDurationMs: stageDurationMs.pdf ?? null,
    xlsxDurationMs: stageDurationMs.xlsx ?? null,

    peakMemoryKib: telemetry.peakMemoryKib,
  };
}
