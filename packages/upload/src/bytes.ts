/** The byte-level gate every upload passes before anything tries to read it as a table.
 *
 * The filename and the browser-supplied content type are never consulted. Both are attacker
 * controlled — a browser reports a CSV as `application/vnd.ms-excel` on a Windows machine with
 * Excel installed, and a client can claim any of it regardless of what it sends — so the only
 * evidence worth acting on is the bytes.
 */

import { MAX_UPLOAD_BYTES } from './limits.ts';
import { reject, type UploadRejection } from './reasons.ts';

/** Container formats we refuse outright, by the bytes they start with.
 *
 * **This is the entire zip-bomb defence: we never unzip anything, so there is no bomb.** It is
 * the concrete answer to REQUIREMENTS.md's "Excel zip bombs" — an `.xlsx` renamed `.csv` is
 * rejected here, at a fixed cost of comparing a few bytes, rather than being decompressed by
 * something downstream that has to guess how far to go.
 *
 * A signature match is `unparseable` rather than a format-specific reason because the answer is
 * the same either way: this is not a CSV, re-export it. `detail` keeps what we actually saw.
 */
const REFUSED_SIGNATURES: readonly { bytes: readonly number[]; looksLike: string }[] = [
  // Local file header, empty archive, and spanned archive. XLSX and every other OOXML file is a
  // ZIP, so this one signature covers the format we are most likely to be handed by mistake.
  { bytes: [0x50, 0x4b, 0x03, 0x04], looksLike: 'a ZIP archive, probably .xlsx' },
  { bytes: [0x50, 0x4b, 0x05, 0x06], looksLike: 'an empty ZIP archive' },
  { bytes: [0x50, 0x4b, 0x07, 0x08], looksLike: 'a spanned ZIP archive' },
  { bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], looksLike: 'a legacy .xls workbook' },
  { bytes: [0x25, 0x50, 0x44, 0x46], looksLike: 'a PDF' },
  { bytes: [0x1f, 0x8b], looksLike: 'a gzip archive' },
];

/** Decide whether these bytes are worth reading as a CSV. Null when they are.
 *
 * Pure and synchronous, so the browser and the server cannot reach different verdicts about the
 * same file. Ordered cheapest and most dangerous first, so a hostile file is refused before
 * anything allocates on its behalf.
 */
export function checkUploadBytes(bytes: Uint8Array): UploadRejection | null {
  if (bytes.byteLength === 0) return reject('empty');

  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return reject('too_large', `${bytes.byteLength} bytes`);
  }

  const signature = REFUSED_SIGNATURES.find((candidate) => startsWith(bytes, candidate.bytes));
  if (signature) return reject('unparseable', `looks like ${signature.looksLike}`);

  // Only now is decoding safe to pay for: the length is bounded and the bytes are not an archive.
  // `trim` drops U+FEFF as well as spaces and newlines, so a file that is nothing but a byte-order
  // mark lands here rather than reaching a parser as a blank table.
  if (new TextDecoder().decode(bytes).trim().length === 0) return reject('empty');

  return null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}
