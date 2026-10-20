/** The country a browser is in, from the IANA time zone it reports, for the users-by-country panel.
 *
 * ICU, which Node carries, lists each region's zones, so the map is built inverted. What it has to
 * get right:
 * 1. ICU still answers for region codes it has replaced, so `DD`, East Germany, would claim
 *    `Europe/Berlin`. A code counts only if `Intl.Locale` keeps it unchanged.
 * 2. A browser may report an alias, such as `Asia/Kolkata` where ICU lists `Asia/Calcutta`.
 *    `Intl.DateTimeFormat` resolves it to ICU's name, and throws for a name it does not know.
 * 3. CLDR, unlike tzdata, keeps a zone per country: `Europe/Amsterdam` is a tzdata link to
 *    `Europe/Brussels`, but here it is the Netherlands.
 *
 * Wrong for a device set to another country's zone, which is fine for a rough split.
 *
 * Rejected:
 * - GeoIP on the visitor's address: a database to refresh, or a third party to send it to, for a
 *   number nobody needs precisely. The host passes no country header (`ARCHITECTURE.md` § Hosting).
 * - `navigator.language`: its region is `en-US` for most of the world's English speakers.
 * - A table generated from tzdata: data Node already carries, and a regeneration chore.
 */

const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

// Built on first use rather than at import, since it takes on the order of 100ms.
let countryByZone: ReadonlyMap<string, string> | undefined;

/** The ISO 3166-1 alpha-2 code for `timeZone`, or null for a name ICU does not know and for zones
 * that belong to no country, such as `UTC`. */
export function countryForTimeZone(timeZone: string): string | null {
  countryByZone ??= buildCountryByZone();
  const canonical = canonicalTimeZone(timeZone);
  return canonical === null ? null : (countryByZone.get(canonical) ?? null);
}

function buildCountryByZone(): ReadonlyMap<string, string> {
  const codes = LETTERS.flatMap((first) => LETTERS.map((second) => first + second));
  return new Map(
    codes.flatMap((code) => {
      const locale = new Intl.Locale(`und-${code}`);
      if (locale.region !== code) return [];
      return (locale.getTimeZones() ?? []).map((zone): [string, string] => [zone, code]);
    }),
  );
}

function canonicalTimeZone(timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}
