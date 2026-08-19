/** Finding the three columns the analysis needs in a header row.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

export type RequiredColumn = 'product' | 'date' | 'weight';

export const REQUIRED_COLUMNS: readonly RequiredColumn[] = ['product', 'date', 'weight'];

/** What each required column may be called, written in normalized form.
 *
 * Deliberately tiny. `quantity` and `qty` are excluded because they count cases, not weight;
 * `total`, `cost` and `sales` because they are spend; and `amount` because it is generic enough to
 * mean either — mapping any of them onto weight produces a confident wrong report, and nothing
 * downstream can tell. A header we do not recognise is a visible rejection the user can fix; a
 * header we recognise wrongly is not.
 */
const ALIASES = {
  product: ['product', 'product name', 'item', 'item name', 'description'],
  date: ['date', 'date ordered', 'order date'],
  weight: ['weight'],
} as const satisfies Record<RequiredColumn, readonly string[]>;

export type ColumnIndexes = Record<RequiredColumn, number>;

export type HeaderFault =
  | { kind: 'missing'; columns: readonly RequiredColumn[] }
  | { kind: 'ambiguous'; column: RequiredColumn; headers: readonly string[] };

export type ColumnsRead = { ok: true; columns: ColumnIndexes } | { ok: false; fault: HeaderFault };

/** Which column is which, given a header record.
 *
 * Columns we do not need are ignored rather than rejected.
 */
export function resolveHeader(fields: readonly string[]): ColumnsRead {
  const matches = new Map<RequiredColumn, { index: number; header: string }[]>(
    REQUIRED_COLUMNS.map((column) => [column, []]),
  );

  fields.forEach((header, index) => {
    const column = columnFor(normalizeHeaderName(header));
    if (column) matches.get(column)?.push({ index, header });
  });

  const missing = REQUIRED_COLUMNS.filter((column) => matches.get(column)?.length === 0);
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

  return {
    ok: true,
    // Every list has exactly one entry by this point, which is what the two checks above proved.
    columns: Object.fromEntries(
      REQUIRED_COLUMNS.map((column) => [column, matches.get(column)?.[0]?.index ?? -1]),
    ) as ColumnIndexes,
  };
}

/** Fold away the ways a spreadsheet writes the same column name. */
export function normalizeHeaderName(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

function columnFor(normalized: string): RequiredColumn | undefined {
  return REQUIRED_COLUMNS.find((column) =>
    (ALIASES[column] as readonly string[]).includes(normalized),
  );
}
