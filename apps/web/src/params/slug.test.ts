import { describe, expect, test } from 'vitest';
import { deriveOrganizationSlug } from '../lib/server/orgs/slug.ts';
import { match } from './slug.ts';

describe('the organization slug route matcher', () => {
  test('accepts a plain slug', () => {
    expect(match('acme-foodservice')).toBe(true);
  });

  test.for([
    ['uppercase', 'Acme'],
    ['a leading hyphen', '-acme'],
    ['a trailing hyphen', 'acme-'],
    ['a doubled hyphen', 'acme--inc'],
    ['an underscore', 'acme_inc'],
    ['empty', ''],
  ])('rejects %s', ([, param]) => {
    expect(match(param as string)).toBe(false);
  });

  // The invariant that actually matters: this matcher must never be tighter than what
  // `deriveOrganizationSlug` can produce, or a legitimately-slugged organization would be
  // unreachable forever. It may be looser (the database CHECK is the backstop for that side).
  test.each([
    'Acme Foodservice',
    'Café Ñoño',
    'Acme, Inc.',
    '  -Acme-  ',
    '日本語 Acme',
    'a'.repeat(100),
  ])('accepts everything deriveOrganizationSlug can produce, for %s', (name) => {
    const slug = deriveOrganizationSlug(name);
    if (slug === null) return;
    expect(match(slug)).toBe(true);
  });
});
