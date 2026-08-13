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

import { MAX_AMOUNT_DIGITS } from '../limits.ts';

export type AmountReading = { ok: true; value: number } | { ok: false; problem: string };

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

const UNIT_ADVICE =
  'the unit for the whole file is the lb or kg choice on the form, so the column holds plain numbers';

export function readAmount(raw: string): AmountReading {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, problem: 'is empty' };

  if (IN_BRACKETS.test(trimmed)) {
    return { ok: false, problem: 'is a bracketed negative; remove credit and return rows' };
  }
  if (trimmed.startsWith('-')) {
    return { ok: false, problem: 'is negative; remove credit and return rows' };
  }
  if (CURRENCY.test(trimmed)) {
    return { ok: false, problem: 'is money, not a weight; check you mapped the right column' };
  }
  if (SCIENTIFIC.test(trimmed)) {
    return {
      ok: false,
      problem: 'is in scientific notation, so the exact figure is already lost; widen the column',
    };
  }
  if (HAS_LETTER.test(trimmed)) {
    return HAS_DIGIT.test(trimmed)
      ? { ok: false, problem: `has a unit in it — ${UNIT_ADVICE}` }
      : { ok: false, problem: 'is not a number' };
  }

  if (!PLAIN_NUMBER.test(trimmed)) {
    return trimmed.includes(',')
      ? {
          ok: false,
          problem: 'has a comma we cannot read; use a full stop for the decimal point',
        }
      : { ok: false, problem: 'is not a plain number, such as 12 or 1234.50' };
  }

  const digits = trimmed.replace(/[,.]/g, '');
  if (digits.length > MAX_AMOUNT_DIGITS) {
    return { ok: false, problem: 'has more digits than any real weight' };
  }

  // `Number`, never `parseFloat`, which stops at the first character it dislikes and returns
  // whatever it read up to there.
  return { ok: true, value: Number(trimmed.replace(/,/g, '')) };
}
