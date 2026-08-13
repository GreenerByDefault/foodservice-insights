import { describe, expect, test } from 'vitest';
import { isFormulaTrigger, readProduct } from './products.ts';

describe('readProduct', () => {
  test('trims the value it keeps', () => {
    expect(readProduct('  Beef mince  ')).toEqual({ ok: true, value: 'Beef mince' });
  });

  test('keeps punctuation a real product name carries', () => {
    expect(readProduct('Beef, minced (80/20) 5" tray')).toMatchObject({ ok: true });
  });

  describe('rejects', () => {
    test.for(['', '   '])('a blank product (%j)', (raw) => {
      expect(readProduct(raw)).toEqual({ ok: false, problem: 'is empty' });
    });

    test.for([
      '-',
      '.',
      'na',
      'N/A',
      'nan',
      'None',
      'null',
      '#N/A',
      '#VALUE!',
      '#REF!',
      '#DIV/0!',
      '#NAME?',
      '#NULL!',
      '#NUM!',
    ])(
      'the placeholder "%s", which the analysis would otherwise categorize as a product',
      (raw) => {
        expect(readProduct(raw)).toEqual({
          ok: false,
          problem: 'is a placeholder rather than a product',
        });
      },
    );

    test.for([
      ['a zero-width space', 'beef​mince'],
      ['a soft hyphen', 'beef­mince'],
      ['a bidi override', 'beef‮mince'],
      ['a tab', 'beef\tmince'],
      ['a line break', 'beef\nmince'],
    ] as const)('%s, which nothing on screen would explain', ([, raw]) => {
      expect(readProduct(raw)).toEqual({
        ok: false,
        problem: 'contains a line break, a tab or an invisible character',
      });
    });
  });
});

describe('isFormulaTrigger', () => {
  test.for([
    '=1+1',
    "=cmd|' /C calc'!A0",
    '@SUM(1+9)*cmd|calc',
    '+HYPERLINK("http://example.com")',
    '-2+3+cmd|calc',
    '  =1+1',
  ])('catches %j', (value) => {
    expect(isFormulaTrigger(value)).toBe(true);
  });

  test.for(['Beef mince', '2% milk', '#10 can tomatoes', '(case) apples', '5" pan'])(
    'leaves the product name %j alone',
    (value) => {
      expect(isFormulaTrigger(value)).toBe(false);
    },
  );
});
