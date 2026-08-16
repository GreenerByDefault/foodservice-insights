/** The form field names and the schemas for the report metadata an upload carries.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { exhaustiveArray } from '@gbd/core';
import type { CountsBasis, UnitSystem } from '@gbd/db';
import * as v from 'valibot';
import { optionalText, parsedJson, requiredText } from '$lib/forms/validation';
import { MAX_FREE_TEXT_LENGTH, MAX_MONTHS } from './limits.ts';

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
  name: requiredText(MAX_FREE_TEXT_LENGTH),
  siteName: optionalText(MAX_FREE_TEXT_LENGTH),
  countsBasis: v.picklist(COUNTS_BASES),
  unitSystem: v.picklist(UNIT_SYSTEMS),
  // One JSON field rather than a form field per month: the column is `jsonb`, and the browser
  // has to serialise the map somehow.
  monthlyCounts: v.pipe(v.nullable(v.string()), parsedJson, MonthlyCountsSchema),
});

export type ReportMetadata = v.InferOutput<typeof ReportMetadataSchema>;
