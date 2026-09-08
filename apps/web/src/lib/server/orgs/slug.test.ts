import { MAX_ORGANIZATION_SLUG_LENGTH, ORGANIZATION_SLUG_PATTERN } from '@gbd/db';
import { describe, expect, test } from 'vitest';
import { deriveOrganizationSlug } from './slug.ts';

describe('deriveOrganizationSlug', () => {
  test('lowercases and hyphenates a plain name', () => {
    expect(deriveOrganizationSlug('Acme Foodservice')).toBe('acme-foodservice');
  });

  test('strips accents rather than dropping the letter under them', () => {
    expect(deriveOrganizationSlug('Café Ñoño')).toBe('cafe-nono');
  });

  test('collapses a run of punctuation to one hyphen', () => {
    expect(deriveOrganizationSlug('Acme, Inc.')).toBe('acme-inc');
  });

  test('trims a leading and trailing separator rather than keeping an edge hyphen', () => {
    expect(deriveOrganizationSlug('  -Acme-  ')).toBe('acme');
  });

  test('truncates at a hyphen boundary rather than splitting a word', () => {
    const name = `${'a'.repeat(MAX_ORGANIZATION_SLUG_LENGTH - 2)} bcdef`;
    expect(deriveOrganizationSlug(name)).toBe('a'.repeat(MAX_ORGANIZATION_SLUG_LENGTH - 2));
  });

  test('cuts mid-word when the first word alone already exceeds the cap', () => {
    const slug = deriveOrganizationSlug('a'.repeat(MAX_ORGANIZATION_SLUG_LENGTH + 10));
    expect(slug).toBe('a'.repeat(MAX_ORGANIZATION_SLUG_LENGTH));
  });

  test('leaves a slug landing exactly at the cap untouched', () => {
    const name = 'a'.repeat(MAX_ORGANIZATION_SLUG_LENGTH);
    expect(deriveOrganizationSlug(name)).toBe(name);
  });

  test('returns null for a name with no a-z0-9 to build an address from', () => {
    expect(deriveOrganizationSlug('———')).toBeNull();
    expect(deriveOrganizationSlug('日本語')).toBeNull();
  });

  test('every result matches ORGANIZATION_SLUG_PATTERN, the CHECK constraint it must satisfy', () => {
    for (const name of ['Acme Foodservice', 'Café Ñoño', 'Acme, Inc.', '  -Acme-  ']) {
      expect(deriveOrganizationSlug(name)).toMatch(ORGANIZATION_SLUG_PATTERN);
    }
  });
});
