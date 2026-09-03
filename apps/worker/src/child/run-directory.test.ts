import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { AnalysisAttemptId } from '@gbd/db';
import { describe, expect, test } from 'vitest';
import { DIRECTORIES_CREATED_BY_PARENT, resultFilePath, runPath } from '../contract/layout.ts';
import { buildRunManifest, ContractError, parseRunManifest } from '../contract/messages.ts';
import { withTemporaryRunRoot } from '../testing/run-root.ts';
import {
  createRunDirectory,
  readFailure,
  readProgress,
  readResult,
  readResultFiles,
  removeRunDirectory,
  writeInputCsv,
  writeManifest,
} from './run-directory.ts';

const ATTEMPT_ID = '0199c0f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f' as AnalysisAttemptId;

const MANIFEST = buildRunManifest({
  analysisAttemptId: ATTEMPT_ID,
  report: {
    name: 'Q1 2026 dining',
    siteName: null,
    countsBasis: 'meals',
    unitSystem: 'lb',
    monthlyCounts: { '2025-01': 12040 },
  },
});

const RESULT = {
  analysisAttemptId: ATTEMPT_ID,
};

async function directoriesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .toSorted();
}

describe('createRunDirectory', () => {
  test('creates every directory the contract says the parent creates, and no others', async () => {
    await withTemporaryRunRoot(async (runRoot) => {
      const runDirectory = await createRunDirectory(runRoot, ATTEMPT_ID);

      expect(runDirectory).toBe(join(runRoot, ATTEMPT_ID));
      expect(await directoriesUnder(runDirectory)).toEqual(
        [...DIRECTORIES_CREATED_BY_PARENT].toSorted(),
      );
    });
  });
});

describe('the inputs the parent writes', () => {
  test('the manifest the parent writes parses back to the same value', async () => {
    await withTemporaryRunRoot(async (runRoot) => {
      const runDirectory = await createRunDirectory(runRoot, ATTEMPT_ID);
      await writeManifest(runDirectory, MANIFEST);

      const written = await readFile(runPath(runDirectory, 'manifest'), 'utf8');

      expect(parseRunManifest(written)).toEqual(MANIFEST);
    });
  });

  test('the input CSV round-trips byte for byte', async () => {
    await withTemporaryRunRoot(async (runRoot) => {
      const runDirectory = await createRunDirectory(runRoot, ATTEMPT_ID);
      // A CSV a user uploaded, so it is bytes and not necessarily valid UTF-8.
      const body = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62, 0x0a, 0xff]);
      await writeInputCsv(runDirectory, body);

      expect(new Uint8Array(await readFile(runPath(runDirectory, 'inputCsv')))).toEqual(body);
    });
  });
});

describe('the documents the child writes', () => {
  test('a document the child has not written is undefined', async () => {
    await withTemporaryRunRoot(async (runRoot) => {
      const runDirectory = await createRunDirectory(runRoot, ATTEMPT_ID);

      expect(await readProgress(runDirectory)).toBeUndefined();
      expect(await readResult(runDirectory)).toBeUndefined();
      expect(await readFailure(runDirectory)).toBeUndefined();
    });
  });

  test('each document is read back through its parser', async () => {
    await withTemporaryRunRoot(async (runRoot) => {
      const runDirectory = await createRunDirectory(runRoot, ATTEMPT_ID);
      await writeFile(runPath(runDirectory, 'progress'), '{"sequence": 7}');
      await writeFile(runPath(runDirectory, 'result'), JSON.stringify(RESULT));
      await writeFile(
        runPath(runDirectory, 'failure'),
        '{"reason": "upstream_api", "detail": "429", "traceback": null}',
      );

      expect(await readProgress(runDirectory)).toEqual({ sequence: 7 });
      expect(await readResult(runDirectory)).toEqual(RESULT);
      expect(await readFailure(runDirectory)).toMatchObject({ reason: 'upstream_api' });
    });
  });

  test('a document the child wrote badly is a contract violation, not an undefined', async () => {
    await withTemporaryRunRoot(async (runRoot) => {
      const runDirectory = await createRunDirectory(runRoot, ATTEMPT_ID);
      await writeFile(runPath(runDirectory, 'progress'), '{"sequence": 0}');

      await expect(readProgress(runDirectory)).rejects.toThrow(ContractError);
    });
  });
});

describe('readResultFiles', () => {
  test('partitions named files into missing and present, reading bytes back exactly', async () => {
    await withTemporaryRunRoot(async (runRoot) => {
      const runDirectory = await createRunDirectory(runRoot, ATTEMPT_ID);
      // Arbitrary bytes, not necessarily valid UTF-8, the same way a report file could arrive.
      const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
      await writeFile(resultFilePath(runDirectory, 'report.pdf'), body);

      const read = await readResultFiles(runDirectory, ['report.pdf', 'report.xlsx']);

      expect(read.missing).toEqual(['report.xlsx']);
      expect([...read.contents].map(([name, bytes]) => [name, new Uint8Array(bytes)])).toEqual([
        ['report.pdf', body],
      ]);
    });
  });

  test('an empty file list reads nothing', async () => {
    await withTemporaryRunRoot(async (runRoot) => {
      const runDirectory = await createRunDirectory(runRoot, ATTEMPT_ID);

      expect(await readResultFiles(runDirectory, [])).toEqual({
        missing: [],
        contents: new Map(),
      });
    });
  });

  test('a read failure other than "missing" propagates instead of counting as missing', async () => {
    await withTemporaryRunRoot(async (runRoot) => {
      const runDirectory = await createRunDirectory(runRoot, ATTEMPT_ID);
      // A directory where a file is expected reads as EISDIR, not ENOENT — the parent's own
      // bug, and not one `readResultFiles` should paper over as an ordinary missing file.
      await mkdir(resultFilePath(runDirectory, 'report.pdf'));

      await expect(readResultFiles(runDirectory, ['report.pdf'])).rejects.toThrow();
    });
  });
});

describe('removeRunDirectory', () => {
  test('removes the whole tree, and does not mind being called twice', async () => {
    await withTemporaryRunRoot(async (runRoot) => {
      const runDirectory = await createRunDirectory(runRoot, ATTEMPT_ID);
      await writeManifest(runDirectory, MANIFEST);

      await removeRunDirectory(runDirectory);
      expect(await directoriesUnder(runRoot)).toEqual([]);

      await removeRunDirectory(runDirectory);
      expect(await directoriesUnder(runRoot)).toEqual([]);
    });
  });
});
