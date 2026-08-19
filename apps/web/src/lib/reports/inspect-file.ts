/** The browser's judgment on a chosen file, before it is ever uploaded.
 *
 * Runs the same size check, the same empty check, and the same `normalizeCsv` the server runs,
 * so a rejection here reads the same as the one the server would send for the same bytes.
 *
 * The normalized CSV is discarded rather than kept: the server always redoes this from the
 * original upload, and a client-normalized file would be a different file from the one the user
 * chose to send.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { describeUnreadableFile } from './csv/describe/index.ts';
import { normalizeCsv } from './csv/normalize.ts';
import { MAX_UPLOAD_BYTES } from './limits.ts';
import type { MonthsFromFile } from './metadata.ts';
import type { RejectedUploadRecord } from './rejection.ts';

export type FileInspection =
  | { ok: true; months: MonthsFromFile }
  | { ok: false; rejection: RejectedUploadRecord };

export async function inspectFile(file: File): Promise<FileInspection> {
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      rejection: describeUnreadableFile({ kind: 'too-large', byteSize: file.size }),
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    return { ok: false, rejection: describeUnreadableFile({ kind: 'empty' }) };
  }

  const csv = normalizeCsv(bytes);
  if (!csv.ok) return { ok: false, rejection: csv.rejection };

  return { ok: true, months: csv.months };
}
