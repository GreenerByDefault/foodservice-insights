/** Accepted rows into the comma-separated CSV the analysis reads. */

export const NORMALIZED_HEADER = ['product', 'date', 'weight'] as const;
export const NORMALIZED_DATE_FORMAT = 'YYYY-MM-DD';

/** A row every rule has already accepted. `weight` carries whatever unit the form declared. */
export type NormalizedRow = { product: string; isoDate: string; weight: number };

export function encodeNormalizedCsv(rows: readonly NormalizedRow[]): Uint8Array {
  const lines = [NORMALIZED_HEADER.join(',')];
  for (const { product, isoDate, weight } of rows) {
    // Only the product needs escaping.
    lines.push(`${escapeCsvField(product)},${isoDate},${weight}`);
  }
  lines.push('');
  return new TextEncoder().encode(lines.join('\n'));
}

/** Exported for `excel/` to render a workbook cell's text the same way this file already
 * escapes one, so a workbook and the CSV saved from it are judged identically.
 */
export function escapeCsvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
