/** The parent's half of the contract, checked against `contract/contract.json`. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '@gbd/core/env';
import { MAX_CACHE_KEY_BYTES } from '@gbd/db';
import { describe, expect, test } from 'vitest';
import { DIRECTORIES_CREATED_BY_PARENT, RESULT_FILE_NAMES, RUN_DIRECTORY } from './layout.ts';
import {
  COUNTS_BASES,
  DIAGNOSTIC_STATUSES,
  EXIT_CODES,
  FAILURE_REASON_CLAIMANT,
  INVOCATION,
  LLM_OPERATIONS,
  QUALITY_CHECKS,
  STAGES,
  UNIT_SYSTEMS,
} from './names.ts';

const contract = JSON.parse(
  readFileSync(join(findRepoRoot(), 'contract', 'contract.json'), 'utf8'),
);

describe('contract/contract.json', () => {
  test('agrees on how the child is invoked', () => {
    expect(contract.invocation).toEqual(INVOCATION);
  });

  test('agrees on the run directory layout', () => {
    const { directoriesCreatedByParent, ...paths } = contract.runDirectory;
    expect(paths).toEqual(RUN_DIRECTORY);
    expect(directoriesCreatedByParent).toEqual(DIRECTORIES_CREATED_BY_PARENT);
  });

  test('agrees on the result file names', () => {
    expect(contract.resultFiles).toEqual(RESULT_FILE_NAMES);
  });

  test('agrees on the report enums the manifest carries', () => {
    expect(contract.reportEnums.countsBasis).toEqual(COUNTS_BASES);
    expect(contract.reportEnums.unitSystem).toEqual(UNIT_SYSTEMS);
  });

  test('agrees on the enums telemetry.json carries', () => {
    expect(contract.telemetryEnums).toEqual({
      llmOperation: LLM_OPERATIONS,
      stage: STAGES,
      qualityCheck: QUALITY_CHECKS,
      diagnosticStatus: DIAGNOSTIC_STATUSES,
    });
  });

  test("bounds a categorization's product as the cache tables do", () => {
    expect(contract.categorization).toEqual({ maxProductBytes: MAX_CACHE_KEY_BYTES });
  });

  test('agrees on the exit codes', () => {
    expect(contract.exitCodes).toEqual(EXIT_CODES);
  });

  test('agrees on who may claim each failure reason', () => {
    expect(contract.failureReasonClaimants).toEqual(FAILURE_REASON_CLAIMANT);
  });
});
