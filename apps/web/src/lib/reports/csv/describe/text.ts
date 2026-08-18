/** Shared prose helpers: quoting, joining, pluralizing, and formatting numbers.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { MAX_QUOTED_CHARS } from '../../limits.ts';

export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

export function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

export function capitalize(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** A value quoted for the user is shortened and stripped of whitespace that would otherwise break
 * layout. Anything worse than a tab was refused while decoding.
 */
export function quote(raw: string): string {
  const flattened = raw.replace(/[\t\n\r]+/g, ' ').trim();
  const shortened =
    flattened.length > MAX_QUOTED_CHARS ? `${flattened.slice(0, MAX_QUOTED_CHARS)}…` : flattened;
  return `"${shortened}"`;
}

/** A small thousands separator, since `Intl` and `toLocaleString` are banned here per the README.md. */
export function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
