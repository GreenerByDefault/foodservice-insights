import { expect, test } from 'vitest';
import { subheading } from './subheading.ts';

const CREATOR = { displayName: 'Ana Ruiz', email: 'ana@example.test' };

test('joins the site name and creator', () => {
  expect(subheading('Riverside Cafeteria', CREATOR)).toBe(
    'Riverside Cafeteria · Created by Ana Ruiz',
  );
});

test('omits the site name when there is none', () => {
  expect(subheading(null, CREATOR)).toBe('Created by Ana Ruiz');
});

test('falls back to email when the creator has no display name', () => {
  expect(subheading(null, { displayName: null, email: 'ana@example.test' })).toBe(
    'Created by ana@example.test',
  );
});

test('says a deleted user submitted it when the creator is null', () => {
  expect(subheading(null, null)).toBe('Created by a deleted user');
});
