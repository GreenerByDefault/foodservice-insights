import { describe, expect, test } from 'vitest';
import { pageTitle } from './page-title.ts';

describe('pageTitle', () => {
  test('puts the most specific segment first and the name last', () => {
    expect(pageTitle('Q1 procurement', 'Acme')).toBe('Q1 procurement · Acme · PLATE');
  });

  test('is the name with its maker when there are no segments', () => {
    expect(pageTitle()).toBe('PLATE (Greener by Default)');
  });
});
