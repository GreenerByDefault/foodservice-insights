import { describe, expect, test } from 'vitest';
import { deriveOrganizationSlug } from './lib/server/orgs/slug.ts';
import { params } from './params.ts';

/** Whether SvelteKit would match `param`, read through the Standard Schema it validates with. */
function accepts(matcher: (typeof params)[keyof typeof params], param: string): boolean {
  const result = matcher['~standard'].validate(param);
  if (result instanceof Promise) throw new Error('Expected a synchronous matcher.');
  return result.issues === undefined;
}

describe('params.slug', () => {
  test('accepts a plain slug', () => {
    expect(accepts(params.slug, 'acme-foodservice')).toBe(true);
  });

  test.for([
    ['uppercase', 'Acme'],
    ['a leading hyphen', '-acme'],
    ['a trailing hyphen', 'acme-'],
    ['a doubled hyphen', 'acme--inc'],
    ['an underscore', 'acme_inc'],
    ['empty', ''],
  ])('rejects %s', ([, param]) => {
    expect(accepts(params.slug, param as string)).toBe(false);
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
    expect(accepts(params.slug, slug)).toBe(true);
  });
});

describe('params.uuid', () => {
  test('accepts a UUID', () => {
    expect(accepts(params.uuid, crypto.randomUUID())).toBe(true);
  });

  test.for([
    ['a word', 'nonsense'],
    ['an empty string', ''],
    ['a UUID with a trailing character', `${crypto.randomUUID()}x`],
    ['a UUID missing its dashes', crypto.randomUUID().replaceAll('-', '')],
    // The shape Postgres would reject with 22P02 while still looking plausible.
    ['a UUID with a non-hex digit', '0000000g-0000-7000-8000-000000000001'],
  ])('rejects %s', ([, param]) => {
    expect(accepts(params.uuid, param as string)).toBe(false);
  });
});
