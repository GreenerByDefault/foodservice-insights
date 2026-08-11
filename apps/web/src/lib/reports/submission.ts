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

import { exhaustiveArray } from '@gbd/core';
import type { CountsBasis, RejectedUploadReason, UnitSystem } from '@gbd/db';
import * as v from 'valibot';
import { readFile, readText } from '$lib/forms/form-data';
import { describeIssues, fieldsWithIssues, optionalText, parsedJson } from '$lib/forms/validation';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_MEGABYTES = MAX_UPLOAD_BYTES / 1024 / 1024;

/** Caps on the free text and the metadata an upload carries. */
export const MAX_REPORT_NAME_LENGTH = 200;
export const MAX_SITE_NAME_LENGTH = 200;
export const MAX_ORIGINAL_FILENAME_LENGTH = 255;

/** Enough for a decade of monthly figures, which is far past any plausible submission. */
export const MAX_MONTHS = 120;

/** The form field names, so the form and the parser cannot drift apart. */
export const FIELD = {
  // We use `report-name` rather than `name` so that iOS does not offer to autofill a person's name.
  name: 'report-name',
  siteName: 'site-name',
  countsBasis: 'counts-basis',
  unitSystem: 'unit-system',
  monthlyCounts: 'monthly-counts',
  file: 'file',
} as const;

export const COUNTS_BASES = exhaustiveArray<CountsBasis>()(['people', 'meals']);
export const UNIT_SYSTEMS = exhaustiveArray<UnitSystem>()(['lb', 'kg']);

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const wholeNumber = v.pipe(v.number(), v.integer(), v.minValue(0));

/** `report.monthly_counts` as month to count, keyed `YYYY-MM`.*/
export const MonthlyCountsSchema = v.pipe(
  v.record(v.pipe(v.string(), v.regex(MONTH_PATTERN, 'is not a YYYY-MM month')), wholeNumber),
  v.check((counts) => Object.keys(counts).length > 0, 'needs at least one month'),
  v.check(
    (counts) => Object.keys(counts).length <= MAX_MONTHS,
    `covers at most ${MAX_MONTHS} months`,
  ),
);

export type MonthlyCounts = v.InferOutput<typeof MonthlyCountsSchema>;

export const ReportMetadataSchema = v.object({
  name: optionalText(MAX_REPORT_NAME_LENGTH),
  siteName: optionalText(MAX_SITE_NAME_LENGTH),
  countsBasis: v.picklist(COUNTS_BASES),
  unitSystem: v.picklist(UNIT_SYSTEMS),
  // One JSON field rather than a form field per month: the column is `jsonb`, and the browser
  // has to serialise the map somehow.
  monthlyCounts: v.pipe(v.nullable(v.string()), parsedJson, MonthlyCountsSchema),
});

export type ReportMetadata = v.InferOutput<typeof ReportMetadataSchema>;

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

export type UploadedFile = FileDescription & { bytes: Uint8Array };

export type Rejection = {
  reason: RejectedUploadReason;
  /** Safe to show the user. */
  message: string;
  /** For `rejected_upload.rejection_detail`. Never shown. */
  detail?: string;
};

export type ValidatedSubmission =
  | { ok: true; metadata: ReportMetadata; file: UploadedFile }
  | {
      ok: false;
      rejection: Rejection;
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
        message: 'Choose a CSV file to upload.',
        detail: 'the request carried no file',
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
      rejection: {
        reason: 'too_large',
        message: `That file is larger than ${MAX_UPLOAD_MEGABYTES}MB.`,
        detail: `${fileDescription.byteSize} bytes`,
      },
    };
  }

  const bytes = new Uint8Array(await raw.file.arrayBuffer());

  if (bytes.byteLength === 0) {
    return {
      ok: false,
      fileDescription,
      bytes,
      rejection: { reason: 'empty', message: 'That file has no rows in it.' },
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
        message: `Check these fields: ${fieldsWithIssues(parsed.issues).join(', ')}.`,
        detail: describeIssues(parsed.issues),
      },
    };
  }

  return { ok: true, file: { ...fileDescription, bytes }, metadata: parsed.output };
}
