import { describe, expect, test } from 'vitest';
import { countryForTimeZone } from './country.ts';

describe('countryForTimeZone', () => {
  test.each([
    ['America/Chicago', 'US'],
    // An alias each way: Firefox reports the first, ICU lists the second.
    ['Asia/Kolkata', 'IN'],
    ['Asia/Calcutta', 'IN'],
    ['Europe/Kyiv', 'UA'],
    ['US/Pacific', 'US'],
    ['europe/london', 'GB'],
    // A tzdata link into Brussels.
    ['Europe/Amsterdam', 'NL'],
    // Claimed by the replaced codes DD and SU too.
    ['Europe/Berlin', 'DE'],
    ['Europe/Moscow', 'RU'],
  ])('%s is %s', (timeZone, country) => {
    expect(countryForTimeZone(timeZone)).toBe(country);
  });

  test.each(['UTC', 'Etc/GMT+5', 'Made/Up', ''])('%j is no country', (timeZone) => {
    expect(countryForTimeZone(timeZone)).toBeNull();
  });

  test('maps every zone Node lists', () => {
    const unmapped = Intl.supportedValuesOf('timeZone').filter(
      (timeZone) => countryForTimeZone(timeZone) === null,
    );

    expect(unmapped).toEqual([]);
  });
});
