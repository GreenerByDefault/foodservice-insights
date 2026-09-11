import { zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { declaredXmlBytes } from './zip.ts';

function anArchive(entries: Readonly<Record<string, number>>): Uint8Array {
  const encoder = new TextEncoder();
  return zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([name, size]) => [name, encoder.encode('x'.repeat(size))]),
    ),
  );
}

describe('declaredXmlBytes', () => {
  test('sums the entries the reader will inflate', () => {
    const bytes = anArchive({
      'xl/workbook.xml': 100,
      'xl/worksheets/sheet1.xml': 400,
      'xl/_rels/workbook.xml.rels': 50,
    });

    expect(declaredXmlBytes(bytes)).toEqual({ ok: true, xmlBytes: 550 });
  });

  test('ignores the entries it will not', () => {
    // `_rels/.rels` is the trap: it ends in `.rels` but not `.xml.rels`, so the library never
    // inflates it either.
    const bytes = anArchive({
      'xl/workbook.xml': 100,
      '_rels/.rels': 700,
      'xl/media/image1.png': 9_000,
      'xl/printerSettings/printerSettings1.bin': 1_500,
    });

    expect(declaredXmlBytes(bytes)).toEqual({ ok: true, xmlBytes: 100 });
  });

  test('counts nothing in an archive holding no XML', () => {
    expect(declaredXmlBytes(anArchive({ 'notes.txt': 40 }))).toEqual({ ok: true, xmlBytes: 0 });
  });

  test.for([
    ['bytes that are not an archive', new TextEncoder().encode('product,date,weight\n')],
    [
      'an archive with its central directory cut off',
      anArchive({ 'xl/workbook.xml': 100 }).slice(0, 60),
    ],
  ] as const)('reports an unreadable directory for %s', ([, bytes]) => {
    expect(declaredXmlBytes(bytes)).toEqual({ ok: false, fault: 'unreadable-directory' });
  });
});
