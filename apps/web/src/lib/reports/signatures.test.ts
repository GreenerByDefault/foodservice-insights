import { describe, expect, test } from 'vitest';
import { spreadsheetSignature } from './signatures.ts';

describe('spreadsheetSignature', () => {
  test.for([
    [
      'an XLSX file, by its zip local-file-header signature',
      [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00],
      'xlsx',
    ],
    [
      'a legacy XLS file, by its OLE2 signature',
      [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
      'xls',
    ],
  ] as const)('recognises %s', ([, bytes, format]) => {
    expect(spreadsheetSignature(Uint8Array.from(bytes))).toBe(format);
  });

  test('is undefined for a CSV whose title line starts "PKG SUMMARY", sharing zip\'s first two bytes but not its header', () => {
    const bytes = new TextEncoder().encode('PKG SUMMARY,region,total\nproduce,west,120\n');

    expect(spreadsheetSignature(bytes)).toBeUndefined();
  });

  test('is undefined for plain CSV text', () => {
    expect(
      spreadsheetSignature(new TextEncoder().encode('product,date\nbeef,2026-01-05')),
    ).toBeUndefined();
  });
});
