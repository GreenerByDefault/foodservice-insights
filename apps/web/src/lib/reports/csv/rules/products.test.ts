import { describe, expect, test } from 'vitest';
import { isFormulaTrigger, readProduct } from './products.ts';

describe('readProduct', () => {
  test('trims the value it keeps', () => {
    expect(readProduct('  Beef mince  ')).toEqual({ ok: true, value: 'Beef mince' });
  });

  test('keeps punctuation a real product name carries', () => {
    expect(readProduct('Beef, minced (80/20) 5" tray')).toMatchObject({ ok: true });
  });

  test.for([
    ['a diacritic', 'Café au lait, jalapeño'],
    ['Hebrew', 'חלה'],
    ['Mandarin', '豆腐'],
  ] as const)('keeps %s a real product name carries', ([, raw]) => {
    expect(readProduct(raw)).toMatchObject({ ok: true });
  });

  describe('rejects', () => {
    test.for(['', '   '])('a blank product (%j)', (raw) => {
      expect(readProduct(raw)).toEqual({ ok: false, fault: 'empty' });
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
        expect(readProduct(raw)).toEqual({ ok: false, fault: 'placeholder' });
      },
    );

    test.for([
      ['a zero-width space', 'beef\u200bmince'],
      ['a soft hyphen', 'beef\u00admince'],
      ['a bidi override', 'beef\u202emince'],
      ['a tab', 'beef\tmince'],
      ['a line break', 'beef\nmince'],
    ] as const)('%s, which nothing on screen would explain', ([, raw]) => {
      expect(readProduct(raw)).toEqual({ ok: false, fault: 'invisible-character' });
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
