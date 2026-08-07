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

import type { CountsBasis, RejectedUploadReason, UnitSystem } from '@gbd/db';
import * as v from 'valibot';
import {
  ACCEPTED_CSV_CONTENT_TYPES,
  MAX_INPUT_FILE_BYTES,
  MAX_MONTHS,
  MAX_ORIGINAL_FILENAME_LENGTH,
  MAX_REPORT_NAME_LENGTH,
  MAX_SITE_NAME_LENGTH,
} from './limits.ts';

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

/** `satisfies` makes a value the database enum does not have a compile error. The reverse — an
 * enum that grows a value — is caught by `submission.test.ts` against `enum_range`.
 */
export const COUNTS_BASES = ['people', 'meals'] as const satisfies readonly CountsBasis[];
export const UNIT_SYSTEMS = ['lb', 'kg'] as const satisfies readonly UnitSystem[];

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

export type UploadedFile = {
  originalFilename: string;
  contentType: string;
  bytes: Uint8Array;
};

export type Rejection = {
  reason: RejectedUploadReason;
  /** Safe to show the user. */
  message: string;
  /** For `rejected_upload.rejection_detail`. Never shown. */
  detail?: string;
};

export type ValidatedSubmission =
  | { ok: true; metadata: ReportMetadata; file: UploadedFile }
  | { ok: false; rejection: Rejection; file: UploadedFile | null };

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
 * On rejection the bytes come back too, so the caller can keep the file — REQUIREMENTS.md
 * requires that even an invalid upload is stored.
 */
export async function validateSubmission(raw: RawSubmission): Promise<ValidatedSubmission> {
  if (!raw.file) {
    return {
      ok: false,
      file: null,
      rejection: {
        reason: 'other',
        message: 'Choose a CSV file to upload.',
        detail: 'the request carried no file',
      },
    };
  }

  const file: UploadedFile = {
    // Truncated rather than rejected: an absurd filename is not the user's problem to fix, and
    // it never reaches a storage key — see `keys.ts`.
    originalFilename: raw.file.name.slice(0, MAX_ORIGINAL_FILENAME_LENGTH),
    contentType: raw.file.type,
    bytes: new Uint8Array(await raw.file.arrayBuffer()),
  };

  for (const check of FILE_CHECKS) {
    const rejection = check(file);
    if (rejection) return { ok: false, file, rejection };
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
      file,
      rejection: {
        reason: 'invalid_metadata',
        message: `Check these fields: ${fieldsWithIssues(parsed.issues).join(', ')}.`,
        detail: describeIssues(parsed.issues),
      },
    };
  }

  return { ok: true, file, metadata: parsed.output };
}

/** What the file has to pass, in order. The first failure is the one recorded.
 *
 * Adding a check later — a CSV parse, a column check, an injection scan — is an entry here
 * rather than a change to any signature. ARCHITECTURE.md § Input file upload and validation
 * describes where this is going; phase 1 stops at the cheap structural checks.
 */
const FILE_CHECKS: readonly ((file: UploadedFile) => Rejection | null)[] = [
  function tooLarge(file) {
    if (file.bytes.byteLength <= MAX_INPUT_FILE_BYTES) return null;
    const megabytes = Math.floor(MAX_INPUT_FILE_BYTES / 1024 / 1024);
    return {
      reason: 'too_large',
      message: `That file is larger than ${megabytes}MB.`,
      detail: `${file.bytes.byteLength} bytes`,
    };
  },

  function empty(file) {
    if (file.bytes.byteLength > 0) return null;
    return { reason: 'empty', message: 'That file is empty.' };
  },

  function unacceptableContentType(file) {
    if (ACCEPTED_CSV_CONTENT_TYPES.includes(file.contentType)) return null;
    // The browser supplies this, so a determined client can claim anything. It is here to catch
    // an honest mistake early; the real check is the CSV parse a later phase adds.
    return {
      reason: 'other',
      message: 'That file does not look like a CSV. Export your data as CSV and try again.',
      detail: `content type ${file.contentType || '(none)'}`,
    };
  },

  function blank(file) {
    // Catches a file that is only a byte-order mark, blank lines, or spaces — which reads as an
    // empty spreadsheet to the user, however many bytes it is.
    if (new TextDecoder().decode(file.bytes).trim().length > 0) return null;
    return { reason: 'empty', message: 'That file has no rows in it.' };
  },
];

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
