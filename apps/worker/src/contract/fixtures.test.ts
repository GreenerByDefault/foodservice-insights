/** The parent's half of the golden fixtures in `contract/fixtures/`. */

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
    const input: RunManifestInput = {
      analysisAttemptId: '0199c0f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f' as AnalysisAttemptId,
      report: {
        name: 'Q1 2026 dining',
        siteName: null,
        organizationName: 'Acme Foodservice',
        countsBasis: 'meals',
        unitSystem: 'lb',
        monthlyCounts: { '2025-01': 12040, '2025-02': 11360, '2025-03': 12890 },
      },
    };

    expect(buildRunManifest(input)).toEqual(JSON.parse(read('valid', 'run.json')));
  });

  test('result.json parses into the values the parent writes to the database', () => {
    const result = parseResult(read('valid', 'result.json'));

    expect(result.analysisAttemptId).toBe('0199c0f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f');
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
