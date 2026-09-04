/** Up to two letters for an account menu's monogram: the first word's initial, plus the last
 * word's when there is more than one. `null` whenever there is nothing usable, which is what
 * makes the caller fall back to an icon rather than render an empty circle.
 *
 * Deliberately never derived from an email address: `orders@` and `xk29@` would each produce a
 * confident-looking monogram that names nobody.
 */

// Skips control/format characters (Cc/Cf: NUL, bidi overrides, ZWJ) so none can become the
// monogram; `u` keeps a surrogate pair as one code point. `exec` stops at the first match rather
// than spreading the whole word into an array, since `displayName` has no length limit.
const FIRST_VISIBLE_CHAR = /[^\p{Cc}\p{Cf}]/u;

function firstVisibleChar(word: string): string {
  return FIRST_VISIBLE_CHAR.exec(word)?.[0] ?? '';
}

export function initials(displayName: string | null): string | null {
  const [firstWord, ...rest] = (displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!firstWord) return null;

  const first = firstVisibleChar(firstWord);
  const lastWord = rest.at(-1);
  const last = lastWord ? firstVisibleChar(lastWord) : '';
  return (first + last).toUpperCase() || null; // empty when nothing survived the filter above
}
