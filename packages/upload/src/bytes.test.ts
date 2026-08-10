/** Inputs are constructed in code rather than committed as fixture files. A BOM, a lone CR and a
 * trailing newline are exactly what git and editors normalize, and `.gitattributes` does not
 * protect them today — a fixture file would silently stop testing what it was written to test.
 */

import { describe, expect, test } from 'vitest';
import { checkUploadBytes } from './bytes.ts';
import { MAX_UPLOAD_BYTES } from './limits.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const A_VALID_CSV = 'product,date,amount\nApples,2025-01-04,12.5\n';

/** `size` bytes of a CSV, for the boundary cases. */
function aCsvOf(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.fill(0x61); // 'a'
  return bytes;
}

test('accepts a plain CSV', () => {
  expect(checkUploadBytes(encode(A_VALID_CSV))).toBeNull();
});

describe('size', () => {
  test('rejects zero bytes as empty', () => {
    expect(checkUploadBytes(new Uint8Array(0))).toMatchObject({ reason: 'empty' });
  });

  test('accepts a file of exactly the limit', () => {
    expect(checkUploadBytes(aCsvOf(MAX_UPLOAD_BYTES))).toBeNull();
  });

  test('rejects one byte over the limit, naming the size it saw', () => {
    expect(checkUploadBytes(aCsvOf(MAX_UPLOAD_BYTES + 1))).toMatchObject({
      reason: 'too_large',
      detail: `${MAX_UPLOAD_BYTES + 1} bytes`,
    });
  });
});

describe('refused container formats', () => {
  test.each([
    ['xlsx / zip', [0x50, 0x4b, 0x03, 0x04], 'a ZIP archive, probably .xlsx'],
    ['empty zip', [0x50, 0x4b, 0x05, 0x06], 'an empty ZIP archive'],
    ['spanned zip', [0x50, 0x4b, 0x07, 0x08], 'a spanned ZIP archive'],
    ['legacy xls', [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 'a legacy .xls workbook'],
    ['pdf', [0x25, 0x50, 0x44, 0x46], 'a PDF'],
    ['gzip', [0x1f, 0x8b], 'a gzip archive'],
  ])('rejects %s', (_name, signature, looksLike) => {
    const bytes = new Uint8Array([...signature, ...encode(A_VALID_CSV)]);

    expect(checkUploadBytes(bytes)).toEqual({
      reason: 'unparseable',
      message: expect.any(String),
      detail: `looks like ${looksLike}`,
    });
  });

  test('a signature truncated to fewer bytes than it needs is not a match', () => {
    // `1F` alone is not gzip, and a CSV is free to start with any byte.
    expect(checkUploadBytes(new Uint8Array([0x1f]))).toBeNull();
  });

  test('accepts a CSV that merely contains a signature away from the start', () => {
    // The sniff reads the first bytes of the file, not a substring search — a product literally
    // named "PK" must not disqualify the file.
    expect(checkUploadBytes(encode(`product\nPK\n%PDF\n`))).toBeNull();
  });
});

describe('blank content', () => {
  test.each([
    ['a byte-order mark alone', Uint8Array.of(0xef, 0xbb, 0xbf)],
    ['spaces and tabs', encode('   \t  ')],
    ['newlines only', encode('\n\n\n')],
    ['a lone carriage return', encode('\r')],
    ['CRLF only', encode('\r\n\r\n')],
    ['a byte-order mark then whitespace', Uint8Array.of(0xef, 0xbb, 0xbf, 0x20, 0x0a)],
  ])('rejects %s as empty', (_name, bytes) => {
    expect(checkUploadBytes(bytes)).toMatchObject({ reason: 'empty' });
  });

  test('accepts a CSV behind a byte-order mark', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode(A_VALID_CSV)]);

    expect(checkUploadBytes(bytes)).toBeNull();
  });
});
