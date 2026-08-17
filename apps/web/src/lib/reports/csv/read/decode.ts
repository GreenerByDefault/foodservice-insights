/** Uploaded bytes into text a CSV parser can work on.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only. In particular `TextDecoder`, not `Buffer`.
 */

export type DecodeFault =
  | { kind: 'signature'; format: 'xlsx' | 'xls' }
  | { kind: 'control-character'; code: number; offset: number }
  | { kind: 'empty' };

export type Decoded = { ok: true; text: string } | { ok: false; fault: DecodeFault };

/** Files that people mistake for a CSV, recognised so we can say which one it is.
 *
 * This is a diagnostic, not a security control. There is no zip bomb to defend against: we never
 * interpret an upload as an archive, only ever as CSV, so nothing is ever decompressed. What this
 * buys is the difference between "line 1 contains control characters" and "that looks like an
 * Excel file" — something a user may get wrong. Resist growing the list; every
 * other binary format already lands on the control-character rule below with an honest message.
 *
 * The filename and the browser-supplied content type are never consulted.
 */
const SIGNATURES = [
  { bytes: [0x50, 0x4b], format: 'xlsx' },
  { bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], format: 'xls' },
] as const;

export function decodeCsv(bytes: Uint8Array): Decoded {
  const signature = SIGNATURES.find((candidate) => startsWith(bytes, candidate.bytes));
  if (signature) return { ok: false, fault: { kind: 'signature', format: signature.format } };

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
