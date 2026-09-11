/** A workbook's zip central directory, read for the one number that decides whether we may unzip
 * it at all — the zip-bomb guard REQUIREMENTS.md § Security asks for.
 *
 * `read-excel-file` inflates every `.xml` and `.xml.rels` entry with no size check of its own, so
 * a 20KB archive whose single sheet declares 4GB of XML would be decompressed before anything
 * measured it. This reads the archive without inflating any of it: `unzipSync` calls `filter` per
 * entry off the central directory, and returning `false` every time decompresses nothing.
 *
 * What it sums is what the archive *declares*, which an archive is free to lie about. Enforcing
 * the declaration is still sound, because `fflate` inflates each entry into a buffer sized to
 * that same declaration and throws rather than growing it: an entry that under-declares inflates
 * to at most what it declared, and one that declares more than the cap never starts.
 */

import { unzipSync } from 'fflate';

/** Must stay in step with `read-excel-file`'s own entry filter: what it skips costs us nothing,
 * so it is not counted here. */
const XML_ENTRY = /\.xml(\.rels)?$/;

export type DeclaredXmlSize =
  | { ok: true; xmlBytes: number }
  | { ok: false; fault: 'unreadable-directory' };

export function declaredXmlBytes(bytes: Uint8Array): DeclaredXmlSize {
  let xmlBytes = 0;
  try {
    unzipSync(bytes, {
      filter: ({ name, originalSize }) => {
        if (XML_ENTRY.test(name)) xmlBytes += originalSize;
        return false;
      },
    });
  } catch {
    // A truncated download and a file that was never a zip look the same from here.
    return { ok: false, fault: 'unreadable-directory' };
  }
  return { ok: true, xmlBytes };
}
