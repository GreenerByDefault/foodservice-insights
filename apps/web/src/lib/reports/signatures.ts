/** Files that people mistake for a CSV, recognised by their bytes so we can say which one it is.
 *
 * This is a diagnostic, not a security control: recognising a signature only decides what we try
 * next, never what we trust. For an `.xlsx`, that "what's next" is real — the browser's `excel/`
 * converter does unzip it — so the zip-bomb guard lives there, in `excel/zip.ts`, checked against
 * the archive's declared size before anything is inflated. An `.xls` has no such path; it is
 * recognised only so the rejection can name it rather than call it a corrupt CSV.
 *
 * Four bytes for the zip signature, not two: a CSV whose title line starts "PKG SUMMARY" shares
 * `PK` with every zip, but not the local-file-header bytes that follow. Matching the full header
 * is what keeps that file readable as text.
 *
 * The filename and the browser-supplied content type are never consulted.
 */

export type SpreadsheetFormat = 'xlsx' | 'xls';

const SIGNATURES = [
  { bytes: [0x50, 0x4b, 0x03, 0x04], format: 'xlsx' },
  { bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], format: 'xls' },
] as const;

export function spreadsheetSignature(bytes: Uint8Array): SpreadsheetFormat | undefined {
  return SIGNATURES.find((candidate) => startsWith(bytes, candidate.bytes))?.format;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}
