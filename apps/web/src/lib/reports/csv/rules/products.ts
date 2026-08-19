/** One cell into a product name, or the reason it is not one.
 *
 * A blank or placeholder product is not a harmless empty row. The analysis coerces the column to
 * text before it checks for nulls, so a missing value becomes a product literally named `nan`,
 * gets categorized, and has weight attributed to it. Nothing downstream can tell that apart from
 * a real product, which is why these are rejections rather than skips.
 *
 * Every pattern here is anchored with bounded quantifiers, and callers length-check a cell before
 * handing it over.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

export type ProductFault = 'empty' | 'placeholder' | 'invisible-character';

export type ProductRead = { ok: true; value: string } | { ok: false; fault: ProductFault };

/** What a spreadsheet leaves behind where a product should be. */
const PLACEHOLDERS = new Set([
  '-',
  '.',
  'na',
  'n/a',
  'nan',
  'none',
  'null',
  '#n/a',
  '#value!',
  '#ref!',
  '#div/0!',
  '#name?',
  '#null!',
  '#num!',
]);

/** Control, format, private-use and surrogate characters.
 *
 * Zero-width spaces, soft hyphens and bidi overrides are invisible, so two products that look
 * identical would be categorized and counted separately with nothing on screen to explain it. Tabs
 * and line breaks are here too: a product name spanning two lines is a broken export. All of them
 * narrow the prompt-injection surface as well, since these strings reach an LLM.
 *
 * We deliberately do not strip them instead — and no NFC, no homoglyph folding either. Rewriting a
 * product name is a guess about what the customer meant, and the whole point here is not to guess.
 */
const INVISIBLE = /\p{Cc}|\p{Cf}|\p{Co}|\p{Cs}/u;

/** What a spreadsheet reads as the start of a formula.
 *
 * Only the product column is checked, and that is what makes the rule usable: the date and weight
 * grammars already reject anything that is not a plain date or a plain number, so `=1+1` in a
 * weight is a bad weight and `-5` is a negative — neither needs to be an injection. Checked over
 * the whole free-text column, `-5` in a product name is vanishingly rare, so the false positives
 * this rule is famous for never arise.
 *
 * A leading tab or carriage return is a trigger too, but `readProduct` has already refused those
 * as invisible characters by the time this runs.
 */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@']);

export function readProduct(raw: string): ProductRead {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, fault: 'empty' };
  if (PLACEHOLDERS.has(trimmed.toLowerCase())) {
    return { ok: false, fault: 'placeholder' };
  }
  if (INVISIBLE.test(trimmed)) {
    return { ok: false, fault: 'invisible-character' };
  }
  return { ok: true, value: trimmed };
}

export function isFormulaTrigger(value: string): boolean {
  // `value` is always a `readProduct` result, so it's already trimmed and we can read index 0.
  return FORMULA_TRIGGERS.has(value.charAt(0));
}
