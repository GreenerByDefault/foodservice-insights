/** The parent's half of the golden fixtures in `contract/fixtures/`.
 *
 * The two stacks validate with different machinery — valibot here, a hand-written cursor over
 * `json.loads` there — so these fixtures are the only thing that proves they agree. The Python
 * counterpart is `python/worker_child/tests/test_fixtures.py`, and it plays the opposite role on
 * each document: whichever side *writes* a message in production asserts its writer reproduces
 * the fixture, and the side that reads it asserts its parser accepts it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '@gbd/core/env';
import type { AnalysisAttemptId } from '@gbd/db';
import { describe, expect, test } from 'vitest';
import {
  buildRunManifest,
  ContractError,
  parseFailure,
  parseProgress,
  parseResult,
  parseRunManifest,
  type RunManifestInput,
} from './messages.ts';

const FIXTURES = join(findRepoRoot(), 'contract', 'fixtures');

/** Every fixture's filename starts with the document it belongs to. Both stacks know this same
 * set, so a typo in a filename fails in both rather than being silently skipped by each.
 */
const PARSERS = {
  run: parseRunManifest,
  progress: parseProgress,
  result: parseResult,
  failure: parseFailure,
} as const;

type DocumentName = keyof typeof PARSERS;

function fixtureNames(directory: string): string[] {
  return readdirSync(join(FIXTURES, directory))
    .filter((name) => name.endsWith('.json'))
    .sort();
}

function read(directory: string, name: string): string {
  return readFileSync(join(FIXTURES, directory, name), 'utf8');
}

function documentOf(fileName: string): string {
  return fileName.split('.')[0] ?? '';
}

function isDocumentName(name: string): name is DocumentName {
  return name in PARSERS;
}

const VALID = fixtureNames('valid');
const INVALID = fixtureNames('invalid');

describe('the fixture set itself', () => {
  test('names every fixture after a document both stacks know', () => {
    const unknown = [...VALID, ...INVALID].filter((name) => !isDocumentName(documentOf(name)));
    expect(unknown).toEqual([]);
  });

  test('covers every document, so a moved directory cannot pass vacuously', () => {
    expect(VALID.sort()).toEqual(['failure.json', 'progress.json', 'result.json', 'run.json']);

    const documentsWithAnInvalidCase = new Set(INVALID.map(documentOf));
    expect([...documentsWithAnInvalidCase].sort()).toEqual(Object.keys(PARSERS).sort());
  });
});

describe('valid fixtures', () => {
  test.each(VALID)('%s parses', (name) => {
    const document = documentOf(name);
    if (!isDocumentName(document)) throw new Error(`unreachable: ${name}`);

    expect(() => PARSERS[document](read('valid', name))).not.toThrow();
  });

  test('run.json is what the parent writes', () => {
    // The parent is the producer here, so this is the strong form: the fixture is a golden
    // output, and any change to `buildRunManifest` has to change the fixture too — which is a
    // `contract/` change, which runs both stacks' CI.
    const input: RunManifestInput = {
      analysisAttemptId: '0199c0f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f' as AnalysisAttemptId,
      report: {
        name: 'Q1 2026 dining',
        siteName: null,
        countsBasis: 'meals',
        unitSystem: 'lb',
        monthlyCounts: { '2025-01': 12040, '2025-02': 11360, '2025-03': 12890 },
      },
      inputFile: {
        originalFilename: 'Q1 exports (final).xlsx',
        byteSize: 184320,
        checksumSha256: 'b1946ac92492d2347c6235b4d2611184e2b5f0c1e0f5a1c9d2ea9b0f2e8a7c31',
      },
    };

    // Parsed values, never bytes: Biome formats `contract/**/*.json`, and the contract must not
    // be coupled to the formatter.
    expect(buildRunManifest(input)).toEqual(JSON.parse(read('valid', 'run.json')));
  });

  test('result.json parses into the values the parent writes to the database', () => {
    const result = parseResult(read('valid', 'result.json'));

    expect(result.charts).toEqual(['emissions_by_month', 'emissions_by_category', 'top_products']);
    expect(result.ai.model).toBe('gemini-2.5-pro');
    expect(result.ai.inputTokens).toBe(918342);
    // A string all the way to Kysely, because `ai_cost_usd` is `numeric(10,4)`.
    expect(result.ai.costUsd).toBe('2.4713');
    expect(result.resultMetadata).toEqual({
      rowsIn: 4821,
      rowsCategorized: 4790,
      productsUncategorized: 31,
    });
  });

  test('failure.json parses into a reason the database accepts', () => {
    const failure = parseFailure(read('valid', 'failure.json'));

    expect(failure.reason).toBe('upstream_api');
    expect(failure.traceback).toContain('Traceback (most recent call last)');
  });

  test('progress.json parses into a sequence', () => {
    expect(parseProgress(read('valid', 'progress.json')).sequence).toBe(7);
  });
});

describe('invalid fixtures', () => {
  test.each(INVALID)('%s is rejected', (name) => {
    const document = documentOf(name);
    if (!isDocumentName(document)) throw new Error(`unreachable: ${name}`);

    expect(() => PARSERS[document](read('invalid', name))).toThrow(ContractError);
  });

  test('rejects bytes that are not JSON at all', () => {
    // Deliberately generated rather than committed: Biome parses `contract/fixtures/`, so a
    // malformed file could not live there.
    expect(() => parseProgress('{"contractVersion": 1,')).toThrow(ContractError);
  });
});

describe('the cross-language number traps', () => {
  // Neither can be expressed as a fixture on both sides at once, so they are pinned here and
  // mirrored in `test_fixtures.py`.

  test('accepts a whole number written as a float, which JSON.parse cannot distinguish', () => {
    // `json.loads` in Python *can* tell 7.0 from 7, so the Python side has to agree to accept it.
    expect(parseProgress('{"contractVersion": 1, "sequence": 7.0}').sequence).toBe(7);
  });

  test('rejects a boolean where a number belongs', () => {
    // Free here — `true` is not a JS number. In Python `bool` subclasses `int`, so that side has
    // to reject it explicitly. `progress.sequence-is-a-bool.json` is the fixture that pins it.
    expect(() => parseProgress('{"contractVersion": 1, "sequence": true}')).toThrow(ContractError);
  });
});
