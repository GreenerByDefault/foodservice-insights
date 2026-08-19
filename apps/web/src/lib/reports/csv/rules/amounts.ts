/** One cell into a non-negative number, or the reason it is not one.
 *
 * The grammar is deliberately narrow, and each way of falling outside it gets its own message,
 * because every one of them is a real customer export we would otherwise read wrongly:
 *
 * - `5 oz` — the analysis strips the unit word and keeps the number, so 5 oz becomes 5 lb. A
 *   silent 16× error, and the single most valuable rejection here.
 * - `1,234` written by a European export, meaning 1.234 — a silent 1000× error.
 * - `$12` or `₹12` — a spend column mapped onto weight. Nothing downstream can tell, and it does
 *   not matter which country's currency it is.
 *
 * Every pattern here is anchored with bounded quantifiers, and callers length-check a cell before
 * handing it over.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { MAX_AMOUNT_DIGITS } from '../../limits.ts';

export type AmountFault =
  | 'empty'
  | 'parenthesized-negative'
  | 'negative'
  | 'money'
  | 'scientific'
  | 'has-a-unit'
  | 'not-a-number'
  | 'comma-decimal'
  | 'not-plain'
  | 'too-many-digits';

export type AmountRead = { ok: true; value: number } | { ok: false; fault: AmountFault };

/** A whole number, or one with a decimal point, optionally grouped in thousands. */
const PLAIN_NUMBER = /^(\d+|\d{1,3}(,\d{3})+)(\.\d+)?$/;
const IN_BRACKETS = /^\(.*\)$/;
/** Every symbol-only currency, so a spend column mapped onto weight is caught regardless of which
 * supplier's country wrote the export. A currency spelled in letters (`kr`, `R`, `USD`) already
 * falls under `HAS_LETTER` below.
 */
const CURRENCY = /[$€£¥₹₩₽₺₫¢]/;
const SCIENTIFIC = /^\d+(\.\d+)?e[+-]?\d+$/i;
const HAS_LETTER = /[a-z]/i;
const HAS_DIGIT = /\d/;

export function readAmount(raw: string): AmountRead {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, fault: 'empty' };

  if (IN_BRACKETS.test(trimmed)) {
    return { ok: false, fault: 'parenthesized-negative' };
  }
  if (trimmed.startsWith('-')) {
    return { ok: false, fault: 'negative' };
  }
  if (CURRENCY.test(trimmed)) {
    return { ok: false, fault: 'money' };
  }
  if (SCIENTIFIC.test(trimmed)) {
    return { ok: false, fault: 'scientific' };
  }
  if (HAS_LETTER.test(trimmed)) {
    return HAS_DIGIT.test(trimmed)
      ? { ok: false, fault: 'has-a-unit' }
      : { ok: false, fault: 'not-a-number' };
  }

  if (!PLAIN_NUMBER.test(trimmed)) {
    return trimmed.includes(',')
      ? { ok: false, fault: 'comma-decimal' }
      : { ok: false, fault: 'not-plain' };
  }

  const withoutCommas = trimmed.replace(/,/g, '');
  const digits = withoutCommas.replace('.', '');
  if (digits.length > MAX_AMOUNT_DIGITS) {
    return { ok: false, fault: 'too-many-digits' };
  }

  // `Number`, never `parseFloat`, which stops at the first character it dislikes and returns
  // whatever it read up to there.
  return { ok: true, value: Number(withoutCommas) };
}
