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
import { checkUploadBytes, MAX_UPLOAD_BYTES } from '@gbd/upload';
import * as v from 'valibot';

/** Caps on the free text and the metadata an upload carries. No database CHECK enforces these —
 * they exist to bound the payload, per REQUIREMENTS.md § Abuse limits, not to describe the
 * column. The limits on the file itself live in `@gbd/upload`, which the browser shares.
 */
export const MAX_REPORT_NAME_LENGTH = 200;
export const MAX_SITE_NAME_LENGTH = 200;
export const MAX_ORIGINAL_FILENAME_LENGTH = 255;

/** Enough for a decade of monthly figures, which is far past any plausible submission. */
export const MAX_MONTHS = 120;

/** The form field names, so the form and the parser cannot drift apart.
 *
 * `report-name` rather than `name` so that iOS does not offer to autofill a person's name.
 */
export const FIELD = {
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

/** `report.monthly_counts` as the database describes it: month to count, keyed `YYYY-MM`.
 *
 * Exported because it is also how a caller narrows the column on the way back out — Kysely
 * types `jsonb` as `unknown`.
 */
export const MonthlyCountsSchema = v.pipe(
  v.record(v.pipe(v.string(), v.regex(MONTH_PATTERN, 'is not a YYYY-MM month')), wholeNumber),
  v.check((counts) => Object.keys(counts).length > 0, 'needs at least one month'),
  v.check(
    (counts) => Object.keys(counts).length <= MAX_MONTHS,
    `covers at most ${MAX_MONTHS} months`,
  ),
);

export type MonthlyCounts = v.InferOutput<typeof MonthlyCountsSchema>;

/** A text field the user may leave blank. Empty becomes `null`, which is what the column holds. */
function optionalText(maxLength: number) {
  return v.pipe(
    v.nullable(v.string()),
    v.transform((value) => value?.trim() ?? ''),
    v.maxLength(maxLength),
    v.transform((value) => value || null),
  );
}

/** `JSON.parse` as a pipe step, so malformed input becomes an issue rather than a throw. */
const parsedJson = v.rawTransform<string | null, unknown>(({ dataset, addIssue, NEVER }) => {
  if (dataset.value === null) {
    addIssue({ message: 'is required' });
    return NEVER;
  }
  try {
    return JSON.parse(dataset.value);
  } catch {
    addIssue({ message: 'is not valid JSON' });
    return NEVER;
  }
});

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

/** What the request claimed about the file, knowable without reading it. */
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
      /** For the `rejected_upload` row. Null only when the request carried no file at all. */
      description: FileDescription | null;
      /** For the blob store. Null when we refused the file without reading it. */
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

/** Decide whether `raw` becomes a report.
 *
 * A rejection carries the bytes back where we have them, because REQUIREMENTS.md requires that
 * even an invalid upload is stored. The one exception is a file refused for its size, which is
 * never read — see below.
 */
export async function validateSubmission(raw: RawSubmission): Promise<ValidatedSubmission> {
  if (!raw.file) {
    return {
      ok: false,
      description: null,
      bytes: null,
      rejection: {
        reason: 'other',
        message: 'Choose a CSV file to upload.',
        detail: 'the request carried no file',
      },
    };
  }

  const description: FileDescription = {
    // Truncated rather than rejected: an absurd filename is not the user's problem to fix, and
    // it never reaches a storage key — see `keys.ts`.
    originalFilename: raw.file.name.slice(0, MAX_ORIGINAL_FILENAME_LENGTH),
    byteSize: raw.file.size,
  };

  // Before `arrayBuffer()`, so an oversized file is never copied — and, more to the point, never
  // written to the blob store. Keeping a rejected upload is a support affordance; keeping one
  // that we refused precisely for its size would defeat the cap it failed.
  if (description.byteSize > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      description,
      bytes: null,
      rejection: {
        reason: 'too_large',
        message: `That file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.`,
        detail: `${description.byteSize} bytes`,
      },
    };
  }

  const bytes = new Uint8Array(await raw.file.arrayBuffer());

  const fileRejection = checkUploadBytes(bytes);
  if (fileRejection) return { ok: false, description, bytes, rejection: fileRejection };

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
      description,
      bytes,
      rejection: {
        reason: 'invalid_metadata',
        message: `Check these fields: ${fieldsWithIssues(parsed.issues).join(', ')}.`,
        detail: describeIssues(parsed.issues),
      },
    };
  }

  return { ok: true, file: { ...description, bytes }, metadata: parsed.output };
}

function readText(form: FormData, field: string): string | null {
  const value = form.get(field);
  return typeof value === 'string' ? value : null;
}

function readFile(form: FormData, field: string): File | null {
  const value = form.get(field);
  if (!(value instanceof File)) return null;
  // A file input the user never touched still submits a part, with no name and no bytes. That
  // is "no file chosen", not an empty file.
  if (value.name === '' && value.size === 0) return null;
  return value;
}

function fieldsWithIssues(issues: readonly v.BaseIssue<unknown>[]): string[] {
  const fields = issues.map((issue) => v.getDotPath(issue)?.split('.')[0] ?? 'the form');
  return [...new Set(fields)];
}

function describeIssues(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues.map((issue) => `${v.getDotPath(issue) ?? '<root>'}: ${issue.message}`).join('; ');
}
