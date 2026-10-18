/** Finding the three columns the analysis needs in a header row. */

import type { UnitSystem } from '@gbd/db';

export type RequiredColumn = 'product' | 'date' | 'weight';

export const REQUIRED_COLUMNS: readonly RequiredColumn[] = ['product', 'date', 'weight'];

/** What each required column may be called, written in normalized form. A weight header may also
 * name its unit — see `WEIGHT_WITH_UNIT`.
 *
 * Deliberately tiny, and every alias names the same thing as the column it maps to. `quantity` and `qty` are excluded because they count cases, not weight;
 * `total`, `cost` and `sales` because they are spend; and `amount` because it is generic enough to
 * mean either — mapping any of them onto weight produces a confident wrong report, and nothing
 * downstream can tell. A header we do not recognize is a visible rejection the user can fix; a
 * header we recognize wrongly is not.
 */
const ALIASES = {
  product: [
    'product',
    'product name',
    'product description',
    'item',
    'item name',
    'item description',
    'description',
  ],
  date: ['date', 'date ordered', 'order date'],
  weight: ['weight', 'product weight'],
} as const satisfies Record<RequiredColumn, readonly string[]>;

/** `Weight (lbs)`, `Weight lbs`, `weight_kg`, `Product Weight (in pounds)`, once normalized. A word
 * after "weight" that is not a unit — `weight class` — matches here but is no weight column. */
const WEIGHT_WITH_UNIT =
  /^(?:product )?weight(?: ?\((?:in )?(?<parenthesized>[a-z]+)\.?\)| (?:in )?(?<bare>[a-z]+)\.?)$/;

const UNITS: ReadonlyMap<string, UnitSystem> = new Map([
  ['lb', 'lb'],
  ['lbs', 'lb'],
  ['pound', 'lb'],
  ['pounds', 'lb'],
  ['kg', 'kg'],
  ['kgs', 'kg'],
  ['kilo', 'kg'],
  ['kilos', 'kg'],
  ['kilogram', 'kg'],
  ['kilograms', 'kg'],
]);

/** A unit food is weighed in that a report cannot be in. Naming it back to the user beats calling
 * their weight column missing. */
export type UnsupportedUnit = 'ounces' | 'grams' | 'tons';

const UNSUPPORTED_UNITS: ReadonlyMap<string, UnsupportedUnit> = new Map([
  ['oz', 'ounces'],
  ['ounce', 'ounces'],
  ['ounces', 'ounces'],
  ['g', 'grams'],
  ['gram', 'grams'],
  ['grams', 'grams'],
  ['ton', 'tons'],
  ['tons', 'tons'],
]);

export type ColumnIndexes = Record<RequiredColumn, number>;

/** `unsupported-unit` stands in for a `missing` that names only the weight, so like `ambiguous`
 * it means the product and date columns were both found. */
export type HeaderFault =
  | { kind: 'missing'; columns: readonly RequiredColumn[] }
  | { kind: 'ambiguous'; column: RequiredColumn; headers: readonly string[] }
  | { kind: 'unsupported-unit'; header: string; unit: UnsupportedUnit };

/** `weightUnit` is present only when the weight header names one. */
export type ColumnsRead =
  | { ok: true; columns: ColumnIndexes; weightUnit?: UnitSystem }
  | { ok: false; fault: HeaderFault };

/** Which column is which, given a header record.
 *
 * Columns we do not need are ignored rather than rejected.
 */
export function resolveHeader(fields: readonly string[]): ColumnsRead {
  const matches = new Map<RequiredColumn, Match[]>(REQUIRED_COLUMNS.map((column) => [column, []]));
  const unsupported: { header: string; unit: UnsupportedUnit }[] = [];

  fields.forEach((header, index) => {
    const reading = readHeaderName(normalizeHeaderName(header));
    if (reading?.kind === 'column') {
      matches.get(reading.column)?.push({ index, header, weightUnit: reading.weightUnit });
    } else if (reading?.kind === 'unsupported-unit') {
      unsupported.push({ header, unit: reading.unit });
    }
  });

  const missing = REQUIRED_COLUMNS.filter((column) => matches.get(column)?.length === 0);
  const [wrongUnit] = unsupported;
  if (wrongUnit && missing.length === 1 && missing[0] === 'weight') {
    return { ok: false, fault: { kind: 'unsupported-unit', ...wrongUnit } };
  }
  if (missing.length > 0) return { ok: false, fault: { kind: 'missing', columns: missing } };

  const ambiguous = REQUIRED_COLUMNS.find((column) => (matches.get(column)?.length ?? 0) > 1);
  if (ambiguous) {
    return {
      ok: false,
      fault: {
        kind: 'ambiguous',
        column: ambiguous,
        headers: (matches.get(ambiguous) ?? []).map(({ header }) => header),
      },
    };
  }

  const weightUnit = matches.get('weight')?.[0]?.weightUnit;
  return {
    ok: true,
    // Every list has exactly one entry by this point, which is what the two checks above proved.
    columns: Object.fromEntries(
      REQUIRED_COLUMNS.map((column) => [column, matches.get(column)?.[0]?.index ?? -1]),
    ) as ColumnIndexes,
    ...(weightUnit && { weightUnit }),
  };
}

/** Fold away the ways a spreadsheet writes the same column name. */
export function normalizeHeaderName(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

type Match = { index: number; header: string; weightUnit?: UnitSystem };

type HeaderReading =
  | { kind: 'column'; column: RequiredColumn; weightUnit?: UnitSystem }
  | { kind: 'unsupported-unit'; unit: UnsupportedUnit };

function readHeaderName(normalized: string): HeaderReading | undefined {
  const column = REQUIRED_COLUMNS.find((column) =>
    (ALIASES[column] as readonly string[]).includes(normalized),
  );
  if (column) return { kind: 'column', column };

  const groups = WEIGHT_WITH_UNIT.exec(normalized)?.groups;
  const word = groups?.parenthesized ?? groups?.bare;
  if (word === undefined) return undefined;
  const weightUnit = UNITS.get(word);
  if (weightUnit) return { kind: 'column', column: 'weight', weightUnit };
  const unit = UNSUPPORTED_UNITS.get(word);
  return unit && { kind: 'unsupported-unit', unit };
}
