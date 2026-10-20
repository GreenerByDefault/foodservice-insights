import { describe, expect, test } from 'vitest';
import {
  type PlannedAttempt,
  planSyntheticHistory,
  SYNTHETIC_HISTORY_SEED,
  SYNTHETIC_HISTORY_SPAN_MS,
  type SyntheticHistoryPlan,
} from './plan.ts';

function attemptsOf(plan: SyntheticHistoryPlan): PlannedAttempt[][] {
  return plan.organizations.flatMap(({ reports }) => reports.map(({ attempts }) => attempts));
}

describe('planSyntheticHistory', () => {
  const plan = planSyntheticHistory(SYNTHETIC_HISTORY_SEED);

  test('plans the same history from the same seed', () => {
    expect(planSyntheticHistory(SYNTHETIC_HISTORY_SEED)).toEqual(plan);
  });

  test('covers every settled status, a retry, and an unconfirmed user', () => {
    const attempts = attemptsOf(plan);

    expect(new Set(attempts.flat().map(({ status }) => status))).toEqual(
      new Set(['succeeded', 'failed', 'canceled']),
    );
    expect(attempts.some((chain) => chain.length > 1)).toBe(true);
    expect(plan.unconfirmedUsers.length).toBeGreaterThan(0);
  });

  test('covers every failure reason', () => {
    const reasons = attemptsOf(plan)
      .flat()
      .flatMap((attempt) => (attempt.status === 'failed' ? [attempt.failureReason] : []));

    expect(new Set(reasons)).toEqual(
      new Set([
        'child_crashed',
        'hung',
        'hard_timeout',
        'infrastructure',
        'contract_violation',
        'upstream_api',
        'abandoned',
        'unknown',
        'shut_down',
        'unusable_data',
      ]),
    );
  });

  test('retries only a failure, and the last attempt settles the report', () => {
    for (const chain of attemptsOf(plan)) {
      expect(chain.slice(0, -1).every(({ status }) => status === 'failed')).toBe(true);
    }
  });

  test('covers both counts bases, and a report without counts', () => {
    const bases = plan.organizations.flatMap(({ reports }) =>
      reports.map(({ countsBasis }) => countsBasis),
    );

    expect(new Set(bases)).toEqual(new Set(['people', 'meals', null]));
  });

  test('gives some failed attempt a categorization under 20%, as unusable data', () => {
    const lowCoverage = attemptsOf(plan)
      .flat()
      .flatMap((attempt) => (attempt.status === 'failed' ? [attempt] : []))
      .filter(({ telemetry: { row } }) => {
        if (row.inputUniqueProducts === null || row.cacheNoMatchProducts === null) return false;
        const uncategorized = row.cacheNoMatchProducts + (row.llmNoMatchProducts ?? 0);
        return 1 - uncategorized / row.inputUniqueProducts < 0.2;
      });

    expect(lowCoverage.map(({ failureReason }) => failureReason)).toContain('unusable_data');
  });

  test('fits every attempt’s stage times inside its run', () => {
    const overruns = attemptsOf(plan)
      .flat()
      .flatMap((attempt) => (attempt.status === 'canceled' ? [] : [attempt]))
      .filter(({ claimedMsAgo, finishedMsAgo, telemetry: { row } }) => {
        const stages = [
          row.readDurationMs,
          row.categorizeDurationMs,
          row.reportDurationMs,
          row.pdfDurationMs,
          row.xlsxDurationMs,
        ];
        const total = stages.reduce<number>((sum, ms) => sum + (ms ?? 0), 0);
        return stages.some((ms) => ms !== null && ms < 0) || total > claimedMsAgo - finishedMsAgo;
      });

    expect(overruns).toEqual([]);
  });

  test('puts every time inside the span, in whole milliseconds', () => {
    const times = [
      ...plan.unconfirmedUsers.map(({ createdMsAgo }) => createdMsAgo),
      ...plan.organizations.flatMap((organization) => [
        organization.createdMsAgo,
        ...[organization.admin, ...organization.members].flatMap((user) => [
          user.createdMsAgo,
          user.emailConfirmedMsAgo as number,
        ]),
        ...organization.reports.map(({ createdMsAgo }) => createdMsAgo),
      ]),
      ...attemptsOf(plan)
        .flat()
        .flatMap((attempt) =>
          attempt.status === 'canceled'
            ? [attempt.createdMsAgo, attempt.finishedMsAgo]
            : [
                attempt.createdMsAgo,
                attempt.claimedMsAgo,
                attempt.finishedMsAgo,
                attempt.notifiedMsAgo,
              ],
        ),
    ];

    expect(
      times.filter((ms) => !(Number.isInteger(ms) && ms > 0 && ms <= SYNTHETIC_HISTORY_SPAN_MS)),
    ).toEqual([]);
  });
});
