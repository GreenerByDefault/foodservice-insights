import { describe, expect, test } from 'vitest';
import { decodeCsv } from './decode.ts';

const utf8 = (text: string) => new TextEncoder().encode(text);

function utf16(text: string, endianness: 'le' | 'be'): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    bytes[index * 2 + (endianness === 'le' ? 0 : 1)] = code & 0xff;
    bytes[index * 2 + (endianness === 'le' ? 1 : 0)] = code >> 8;
  }
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

describe('decodeCsv', () => {
  test('reads plain UTF-8', () => {
    expect(decodeCsv(utf8('product,date\nbeef,2026-01-05'))).toEqual({
      ok: true,
      text: 'product,date\nbeef,2026-01-05',
    });
  });

  test('drops a UTF-8 byte order mark', () => {
    const bytes = concat(Uint8Array.of(0xef, 0xbb, 0xbf), utf8('product'));

    expect(decodeCsv(bytes)).toEqual({ ok: true, text: 'product' });
  });

  test.for([
    ['little', 'le', Uint8Array.of(0xff, 0xfe)],
    ['big', 'be', Uint8Array.of(0xfe, 0xff)],
  ] as const)('reads UTF-16 %s-endian and drops its byte order mark', ([, endianness, mark]) => {
    const bytes = concat(mark, utf16('product,date', endianness));

    expect(decodeCsv(bytes)).toEqual({ ok: true, text: 'product,date' });
  });

  test('falls back to Windows-1252 when the bytes are not valid UTF-8', () => {
    // 0xE9 alone is é in Windows-1252 and an incomplete sequence in UTF-8. Excel on Windows
    // writes this by default, and re-emitting UTF-8 is what makes accepting it safe.
    const bytes = concat(utf8('caf'), Uint8Array.of(0xe9));

    expect(decodeCsv(bytes)).toEqual({ ok: true, text: 'café' });
  });

  test.for([
    ['CRLF', 'a\r\nb'],
    ['a lone CR', 'a\rb'],
  ] as const)('normalizes %s to a newline', ([, text]) => {
    expect(decodeCsv(utf8(text))).toEqual({ ok: true, text: 'a\nb' });
  });

  describe('rejects', () => {
    test.for([
      [
        'an XLSX file, by its ZIP signature',
        Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00),
        'xlsx',
      ],
      [
        'a legacy XLS file, by its OLE2 signature',
        Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1),
        'xls',
      ],
    ] as const)('%s', ([, bytes, format]) => {
      expect(decodeCsv(bytes)).toEqual({ ok: false, fault: { kind: 'signature', format } });
    });

    test.for([
      ['little', 'le'],
      ['big', 'be'],
    ] as const)(
      'UTF-16 %s-endian with no byte order mark, which decodes as valid UTF-8 full of NULs',
      ([, endianness]) => {
        expect(decodeCsv(utf16('product,date', endianness))).toMatchObject({
          ok: false,
          fault: { kind: 'control-character' },
        });
      },
    );

    test('a control character in the middle of otherwise fine text, with its offset kept', () => {
      const bytes = concat(utf8('product'), Uint8Array.of(0x01), utf8('date'));

      expect(decodeCsv(bytes)).toEqual({
        ok: false,
        fault: { kind: 'control-character', code: 0x01, offset: 7 },
      });
    });

    test('a file of nothing but whitespace', () => {
      expect(decodeCsv(utf8(' \n\t\n '))).toEqual({ ok: false, fault: { kind: 'empty' } });
    });

    test('a completely empty file', () => {
      expect(decodeCsv(new Uint8Array())).toEqual({ ok: false, fault: { kind: 'empty' } });
    });

    test('a file that is only a byte order mark', () => {
      expect(decodeCsv(Uint8Array.of(0xef, 0xbb, 0xbf))).toEqual({
        ok: false,
        fault: { kind: 'empty' },
      });
    });
  });

  test('keeps the tabs and newlines a CSV is allowed to contain', () => {
    expect(decodeCsv(utf8('a\tb\nc'))).toEqual({ ok: true, text: 'a\tb\nc' });
  });
});
