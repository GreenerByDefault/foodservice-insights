/** Uploaded bytes into text a CSV parser can work on.
 *
 * Uses `TextDecoder`, never `Buffer` — this runs in the browser too.
 */

import { spreadsheetSignature } from '../../signatures.ts';

export type DecodeFault =
  | { kind: 'signature'; format: 'xlsx' | 'xls' }
  | { kind: 'control-character'; code: number; offset: number }
  | { kind: 'empty' };

export type Decoded = { ok: true; text: string } | { ok: false; fault: DecodeFault };

export function decodeCsv(bytes: Uint8Array): Decoded {
  const format = spreadsheetSignature(bytes);
  if (format) return { ok: false, fault: { kind: 'signature', format } };

  const text = normalizeLineEndings(decodeText(bytes));

  // Anything outside tab, carriage return and newline means these bytes are not text. This is
  // also what catches UTF-16 with no byte order mark: an ASCII file encoded UTF-16LE is valid
  // UTF-8 that decodes to `p\0r\0o\0…`, so only the NULs give it away. Checking the decoded text
  // rather than the raw bytes is what keeps real UTF-16 from tripping over its own encoding.
  const controlAt = findControlCharacter(text);
  if (controlAt !== undefined) {
    return {
      ok: false,
      fault: {
        kind: 'control-character',
        code: text.charCodeAt(controlAt),
        offset: controlAt,
      },
    };
  }

  if (text.trim() === '') return { ok: false, fault: { kind: 'empty' } };

  return { ok: true, text };
}

/** Decode `bytes`, preferring the encoding their byte order mark declares. `TextDecoder` strips a
 * mark matching its own encoding, so none of them survives into the text.
 */
function decodeText(bytes: Uint8Array): string {
  if (startsWith(bytes, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(bytes);
  if (startsWith(bytes, [0xfe, 0xff])) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Unlike UTF-8, Windows-1252 has no invalid byte sequences — the WHATWG spec maps every one
    // of the 256 byte values to some character, even the ones Windows-1252 itself leaves
    // unassigned — so this decode can never throw and needs no further fallback. Reading
    // non-UTF-8 bytes this way is safe only because we re-emit UTF-8: the worst case is mojibake
    // in a product name, which beats refusing what Excel on Windows writes by default.
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** This runs on the raw text before anything parses out quoted fields, so it also normalizes a
 * line ending that sits inside one — meaning the CSV we emit has one kind of line ending
 * throughout, and `parse.ts` never has to treat `\r` as data.
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function findControlCharacter(text: string): number | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0x1f || code === 0x09 || code === 0x0a || code === 0x0d) continue;
    return index;
  }
  return undefined;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}
