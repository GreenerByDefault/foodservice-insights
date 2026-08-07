/** The parent's half of the contract, checked against `contract/contract.json`.
 *
 * `contract.json` is the tiebreaker between the two stacks, not a runtime input: nothing reads it
 * outside this test and its Python counterpart. Renaming a path on one side alone therefore fails
 * that side's own unit tests, which is what makes the path-filtered CI in `.github/filters.yml`
 * safe — the other stack's jobs may never run.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '@gbd/core/env';
import { describe, expect, test } from 'vitest';
import {
  CHART_KEY_PATTERN,
  chartFileName,
  DIRECTORIES_CREATED_BY_PARENT,
  RESULT_FILE_NAMES,
  RUN_DIRECTORY,
} from './layout.ts';
import {
  CONTRACT_VERSION,
  COUNTS_BASES,
  EXIT_CODES,
  FAILURE_REASON_CLAIMANT,
  INVOCATION,
  UNIT_SYSTEMS,
} from './names.ts';

const contract = JSON.parse(
  readFileSync(join(findRepoRoot(), 'contract', 'contract.json'), 'utf8'),
);

describe('contract/contract.json', () => {
  test('agrees on the contract version', () => {
    expect(contract.contractVersion).toBe(CONTRACT_VERSION);
  });

  test('agrees on how the child is invoked', () => {
    expect(contract.invocation).toEqual(INVOCATION);
  });

  test('agrees on the run directory layout', () => {
    const { directoriesCreatedByParent, ...paths } = contract.runDirectory;
    expect(paths).toEqual(RUN_DIRECTORY);
    expect(directoriesCreatedByParent).toEqual(DIRECTORIES_CREATED_BY_PARENT);
  });

  test('agrees on the result file names', () => {
    const { chartExample, ...fixedNames } = contract.resultFiles;
    expect(fixedNames).toEqual(RESULT_FILE_NAMES);

    // A golden value rather than a duplicated template, so a changed derivation on either side
    // shows up as a mismatched string instead of two rules that merely look alike.
    expect(chartFileName(chartExample.chartKey)).toBe(chartExample.fileName);
    expect(chartExample.chartKey).toMatch(CHART_KEY_PATTERN);
  });

  test('agrees on the report enums the manifest carries', () => {
    expect(contract.reportEnums.countsBasis).toEqual(COUNTS_BASES);
    expect(contract.reportEnums.unitSystem).toEqual(UNIT_SYSTEMS);
  });

  test('agrees on the exit codes', () => {
    expect(contract.exitCodes).toEqual(EXIT_CODES);
  });

  test('agrees on who may claim each failure reason', () => {
    // Tied to the database at the other end: `FAILURE_REASON_CLAIMANT` is
    // `satisfies Record<AnalysisFailureReason, …>`, so a migration that adds a reason breaks the
    // build here before it can reach this comparison.
    expect(contract.failureReasonClaimants).toEqual(FAILURE_REASON_CLAIMANT);
  });
});
