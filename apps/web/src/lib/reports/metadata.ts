/** The form field names and the schemas for the report metadata an upload carries. */

import { exhaustiveArray } from '@gbd/core';
import type { CountsBasis, UnitSystem } from '@gbd/db';
import * as v from 'valibot';
import { MIN_NAME_LENGTH, optionalText, parsedJson, requiredText } from '#lib/forms/validation.js';
import { MAX_FREE_TEXT_LENGTH, MAX_MONTHS } from './limits.ts';

/** The form field names, so the form and the parser cannot drift apart. */
export const FIELD = {
  // We use `report-name` rather than `name` so that iOS does not offer to autofill a person's name.
  name: 'report-name',
  siteName: 'site-name',
  countsBasis: 'counts-basis',
  unitSystem: 'unit-system',
  monthlyCounts: 'monthly-counts',
  csvFile: 'csv-file',
  workbook: 'workbook',
} as const;

export const COUNTS_BASES = exhaustiveArray<CountsBasis>()(['people', 'meals']);

/** The `counts-basis` answer for a report without counts. It exists only in the form: the server
 * stores a report without counts as NULL in both `report.counts_basis` and `report.monthly_counts`. */
export const NO_COUNTS = 'none';

/** Every answer the upload form offers under "Diners or meals served". */
export type CountsBasisChoice = CountsBasis | typeof NO_COUNTS;

export const COUNTS_BASIS_CHOICES = exhaustiveArray<CountsBasisChoice>()([
  ...COUNTS_BASES,
  NO_COUNTS,
]);

export const COUNTS_BASIS_LABELS: Record<CountsBasisChoice, string> = {
  people: 'Diners',
  meals: 'Meals',
  none: 'Skip counts',
};

export const UNIT_SYSTEMS = exhaustiveArray<UnitSystem>()(['lb', 'kg']);

/** The upload form's radio labels, which the report page echoes back. */
export const UNIT_NAMES: Record<UnitSystem, string> = {
  lb: 'Pounds (lb)',
  kg: 'Kilograms (kg)',
};

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const wholeNumber = v.pipe(v.number(), v.integer(), v.minValue(1, 'needs a count of at least 1'));

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

/** The months a CSV's rows cover: `YYYY-MM`, sorted ascending, deduplicated, and never empty. */
export type MonthsFromFile = readonly string[];

export const ReportMetadataSchema = v.pipe(
  // A `variant` alone stops at a bad `countsBasis` without checking anything else, so the other
  // fields sit beside it in an `intersect`, which reports every field's problem at once.
  v.intersect([
    v.object({
      name: requiredText({ minLength: MIN_NAME_LENGTH, maxLength: MAX_FREE_TEXT_LENGTH }),
      siteName: optionalText({ minLength: MIN_NAME_LENGTH, maxLength: MAX_FREE_TEXT_LENGTH }),
      unitSystem: v.picklist(UNIT_SYSTEMS),
    }),
    v.variant('countsBasis', [
      v.object({
        countsBasis: v.literal(NO_COUNTS),
        monthlyCounts: v.null('must be absent without counts'),
      }),
      v.object({
        countsBasis: v.picklist(COUNTS_BASES),
        // One JSON field rather than a form field per month: the column is `jsonb`, and the
        // browser has to serialise the map somehow.
        monthlyCounts: v.pipe(v.nullable(v.string()), parsedJson, MonthlyCountsSchema),
      }),
    ]),
  ]),
  v.transform(({ countsBasis, monthlyCounts, ...rest }) => ({
    ...rest,
    counts: countsBasis === NO_COUNTS ? null : { basis: countsBasis, monthly: monthlyCounts },
  })),
);

export type ReportMetadata = v.InferOutput<typeof ReportMetadataSchema>;

/** A form field that carries report metadata, named as `ReportMetadataSchema`'s issues name it. */
export type MetadataField = Exclude<keyof typeof FIELD, 'csvFile' | 'workbook'>;

/** Each field as the upload form labels it, for a rejection to name. */
export const FIELD_LABELS: Record<MetadataField, string> = {
  name: 'Report name',
  siteName: 'Site name',
  countsBasis: 'Diners or meals served',
  unitSystem: 'Weight unit',
  monthlyCounts: 'Diners or meals per month',
};
