/** Turning a submitted form into either a report to write or a rejection to record.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 *
 * The report metadata is validated again, independently, by
 * `apps/worker/src/contract/messages.ts` on its way to the analysis child. That duplication is
 * deliberate: this file decides what the app will accept from a stranger, and that one asserts
 * what the two worker processes have agreed to exchange.
 */

import type { InputFileVariants } from '@gbd/storage';
import * as v from 'valibot';
import { readFile, readText } from '$lib/forms/form-data';
import { describeIssues, fieldsWithIssues } from '$lib/forms/validation';
import { describeUnreadableFile } from './csv/describe/index.ts';
import { normalizeCsv } from './csv/normalize.ts';
import { MAX_ORIGINAL_FILENAME_LENGTH, MAX_UPLOAD_BYTES } from './limits.ts';
import { FIELD, type ReportMetadata, ReportMetadataSchema } from './metadata.ts';
import { monthsWithoutCounts } from './monthly-coverage.ts';
import type { RejectedUploadRecord } from './rejection.ts';

/** Exactly what arrived, before anything has judged it. Recorded verbatim on a rejection. */
export type RawSubmission = {
  name: string | null;
  siteName: string | null;
  countsBasis: string | null;
  unitSystem: string | null;
  monthlyCounts: string | null;
  file: File | null;
};

export type FileDescription = {
  originalFilename: string;
  byteSize: number;
};

export type UploadedFile = FileDescription & { variants: InputFileVariants };

export type ValidatedSubmission =
  | { ok: true; metadata: ReportMetadata; file: UploadedFile }
  | {
      ok: false;
      rejection: RejectedUploadRecord;
      /** Null only when the request carried no file at all. */
      fileDescription: FileDescription | null;
      /** For the blob store. Null when we refused the file before reading it. */
      bytes: Uint8Array | null;
    };

export function readSubmission(form: FormData): RawSubmission {
  return {
    name: readText(form, FIELD.name),
    siteName: readText(form, FIELD.siteName),
    countsBasis: readText(form, FIELD.countsBasis),
    unitSystem: readText(form, FIELD.unitSystem),
    monthlyCounts: readText(form, FIELD.monthlyCounts),
    file: readFile(form, FIELD.file),
  };
}

/** Decide whether `raw` becomes a report. */
export async function validateSubmission(raw: RawSubmission): Promise<ValidatedSubmission> {
  if (!raw.file) {
    return {
      ok: false,
      fileDescription: null,
      bytes: null,
      rejection: {
        reason: 'other',
        summary: 'Choose a CSV file to upload.',
        rejectionDetail: 'the request carried no file',
      },
    };
  }

  const fileDescription: FileDescription = {
    // Truncate long file names rather than reject them.
    originalFilename: raw.file.name.slice(0, MAX_ORIGINAL_FILENAME_LENGTH),
    byteSize: raw.file.size,
  };

  if (fileDescription.byteSize > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      fileDescription,
      // We don't upload large files to the blob store.
      bytes: null,
      rejection: describeUnreadableFile({ kind: 'too-large', byteSize: fileDescription.byteSize }),
    };
  }

  const bytes = new Uint8Array(await raw.file.arrayBuffer());

  if (bytes.byteLength === 0) {
    return {
      ok: false,
      fileDescription,
      bytes,
      rejection: describeUnreadableFile({ kind: 'empty' }),
    };
  }

  const parsed = v.safeParse(ReportMetadataSchema, {
    name: raw.name,
    siteName: raw.siteName,
    countsBasis: raw.countsBasis,
    unitSystem: raw.unitSystem,
    monthlyCounts: raw.monthlyCounts,
  });
  if (!parsed.success) {
    return {
      ok: false,
      fileDescription,
      bytes,
      rejection: {
        reason: 'invalid_metadata',
        summary: `Check these fields: ${fieldsWithIssues(parsed.issues).join(', ')}.`,
        rejectionDetail: describeIssues(parsed.issues),
      },
    };
  }

  const csv = normalizeCsv(bytes);
  if (!csv.ok) return { ok: false, fileDescription, bytes, rejection: csv.rejection };

  const uncounted = monthsWithoutCounts(csv.months, parsed.output.monthlyCounts);
  if (uncounted) return { ok: false, fileDescription, bytes, rejection: uncounted };

  return {
    ok: true,
    file: { ...fileDescription, variants: { original: bytes, normalized: csv.normalized } },
    metadata: parsed.output,
  };
}
