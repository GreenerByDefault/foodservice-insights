/** The parent's half of the golden fixtures in `contract/fixtures/`. */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '@gbd/core/env';
import { type AnalysisAttemptId, MAX_CACHE_KEY_BYTES } from '@gbd/db';
import { describe, expect, test } from 'vitest';
import {
  buildCategorizationCache,
  buildRunManifest,
  ContractError,
  parseCategorizationCache,
  parseFailure,
  parseNewCategorizations,
  parseProgress,
  parseResult,
  parseRunManifest,
  parseTelemetry,
  type ReportCounts,
  type RunManifestInput,
} from './messages.ts';
import { MAX_FINDING_SAMPLE_VALUES, MAX_FINDING_TEXT_BYTES } from './names.ts';

const FIXTURES = join(findRepoRoot(), 'contract', 'fixtures');

const PARSERS = {
  run: parseRunManifest,
  progress: parseProgress,
  result: parseResult,
  failure: parseFailure,
  telemetry: parseTelemetry,
  'categorization-cache': parseCategorizationCache,
  'new-categorizations': parseNewCategorizations,
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
    expect(VALID.sort()).toEqual([
      'categorization-cache.json',
      'failure.json',
      'new-categorizations.json',
      'progress.json',
      'result.json',
      'run.json',
      'run.no-counts.json',
      'telemetry.json',
      'telemetry.partial.json',
    ]);

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

  test.each<[string, ReportCounts | null]>([
    [
      'run.json',
      { basis: 'meals', monthly: { '2025-01': 12040, '2025-02': 11360, '2025-03': 12890 } },
    ],
    ['run.no-counts.json', null],
  ])('%s is what the parent writes', (name, counts) => {
    const input: RunManifestInput = {
      analysisAttemptId: '0199c0f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f' as AnalysisAttemptId,
      report: {
        name: 'Q1 2026 dining',
        siteName: null,
        organizationName: 'Acme Foodservice',
        unitSystem: 'lb',
        counts,
      },
    };

    expect(buildRunManifest(input)).toEqual(JSON.parse(read('valid', name)));
  });

  test('result.json parses into exactly what the parent inserts', () => {
    const text = read('valid', 'result.json');

    expect(parseResult(text)).toEqual(JSON.parse(text));
  });

  test('result.json accepts a finding at every bound', () => {
    const document = JSON.parse(read('valid', 'result.json'));
    const atTheBound = 'é'.repeat(MAX_FINDING_TEXT_BYTES / 2);
    document.findings[0].message = atTheBound;
    document.findings[0].sampleValues = Array(MAX_FINDING_SAMPLE_VALUES).fill(atTheBound);

    expect(parseResult(JSON.stringify(document))).toEqual(document);
  });

  test('result.json accepts a report with no findings', () => {
    const document = { ...JSON.parse(read('valid', 'result.json')), findings: [] };

    expect(parseResult(JSON.stringify(document))).toEqual(document);
  });

  test('failure.json parses into a reason the database accepts', () => {
    const failure = parseFailure(read('valid', 'failure.json'));

    expect(failure.reason).toBe('upstream_api');
    expect(failure.traceback).toContain('Traceback (most recent call last)');
  });

  test.each(['telemetry.json', 'telemetry.partial.json'])(
    '%s parses into exactly what the parent inserts',
    (name) => {
      const text = read('valid', name);

      expect(parseTelemetry(text)).toEqual(JSON.parse(text));
    },
  );

  test('telemetry.json accepts the nulls and empties its fixture does not exercise', () => {
    const telemetry = JSON.parse(read('valid', 'telemetry.json'));
    // An operation whose every call failed has no served model.
    telemetry.llmUsage[0].servedModel = null;
    telemetry.report.plantProteinPctByWeight = 12.5;
    // A report without counts has no per-diner figure.
    telemetry.report.co2eKgPerDinerOrMeal = null;
    telemetry.report.findingCounts = [];

    expect(parseTelemetry(JSON.stringify(telemetry))).toEqual(telemetry);
  });

  test('categorization-cache.json is what the parent writes', () => {
    const rows = [
      {
        product: 'Chicken Breast, Boneless 4oz',
        category: 'Poultry (Chicken & Turkey)',
        cleanedName: 'chicken breast',
      },
      { product: 'Napkins 2-ply', category: 'No Matches Found', cleanedName: null },
      {
        product: 'Oat Milk "Barista" 32oz,\ncase of 12',
        category: 'Oat Milk',
        cleanedName: 'oat milk',
      },
    ];

    expect(buildCategorizationCache(rows)).toEqual(
      JSON.parse(read('valid', 'categorization-cache.json')),
    );
  });

  test('categorization-cache.json refuses a row the child could not match', () => {
    expect(() =>
      buildCategorizationCache([{ product: '', category: 'Oat Milk', cleanedName: null }]),
    ).toThrow(ContractError);
  });

  test('new-categorizations.json parses into exactly what the parent inserts', () => {
    const text = read('valid', 'new-categorizations.json');

    expect(parseNewCategorizations(text)).toEqual(JSON.parse(text));
  });

  test('new-categorizations.json accepts a product of exactly the byte bound', () => {
    const document = JSON.parse(read('valid', 'new-categorizations.json'));
    document.rows[0].product = 'é'.repeat(MAX_CACHE_KEY_BYTES / 2);

    expect(parseNewCategorizations(JSON.stringify(document))).toEqual(document);
  });

  test('new-categorizations.json rejects a blank cleaned name, which the table refuses', () => {
    const document = JSON.parse(read('valid', 'new-categorizations.json'));
    document.rows[0].cleanedName = ' ';

    expect(() => parseNewCategorizations(JSON.stringify(document))).toThrow(ContractError);
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
    expect(() => parseProgress('{"sequence":')).toThrow(ContractError);
  });
});

describe('the cross-language number traps', () => {
  test('accepts a whole number written as a float, which JavaScript JSON.parse cannot distinguish', () => {
    expect(parseProgress('{"sequence": 7.0}').sequence).toBe(7);
  });

  test('rejects a boolean where a number belongs', () => {
    // `progress.sequence-is-a-bool.json` pins the same case in Python, where `bool` subclasses
    // `int` and needs an explicit check.
    expect(() => parseProgress('{"sequence": true}')).toThrow(ContractError);
  });
});
