// Temporary: part of the go-live import of GBD's cache CSVs
// (.claude/plans/caches-to-supabase.md). This directory is deleted after the final import.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '@gbd/core/env';
import { describe, expect, test } from 'vitest';
import { MAX_CACHE_KEY_BYTES } from '../../src/constraints.ts';
import {
  CATEGORIES_YAML_PATH,
  categoryVocabulary,
  cleanEntreeClassifications,
  cleanProductCategorizations,
  type EntreeColumn,
  NO_MATCHES_FOUND,
  type ProductColumn,
} from './clean.ts';
import type { CsvRecord } from './csv.ts';

const OVER_LONG_KEY = 'x'.repeat(MAX_CACHE_KEY_BYTES + 1);

/** Records numbered from line 2, as under a header. */
function records<Column extends string>(...values: Record<Column, string>[]): CsvRecord<Column>[] {
  return values.map((value, index) => ({ line: index + 2, values: value }));
}

describe('categoryVocabulary', () => {
  test('reads each cool_food_pledge_name from the real YAML, plus No Matches Found', () => {
    const yaml = readFileSync(join(findRepoRoot(), CATEGORIES_YAML_PATH), 'utf8');
    const categoryCount = yaml.split('\n').filter((line) => line.startsWith('- name:')).length;

    const vocabulary = categoryVocabulary(yaml);

    expect(vocabulary).toHaveLength(categoryCount + 1);
    expect(vocabulary).toContain('Poultry (Chicken & Turkey)');
    expect(vocabulary).toContain("Milk (Cow's milk)");
    expect(vocabulary).toContain(NO_MATCHES_FOUND);
    // The short `name`, which rows do not carry.
    expect(vocabulary).not.toContain('Poultry');
  });

  test('throws on a quoted value, which it would misread', () => {
    expect(() => categoryVocabulary('- name: Beef\n  cool_food_pledge_name: "Beef"\n')).toThrow(
      'Cannot read quoted YAML values',
    );
  });
});

describe('cleanProductCategorizations', () => {
  const VOCABULARY = ['Beef', 'Liquid Eggs', NO_MATCHES_FOUND];

  function product(
    product: string,
    category: string,
    cleanedItemNames = '',
  ): Record<ProductColumn, string> {
    return { product, category, cleaned_item_names: cleanedItemNames };
  }

  test('strips the product and category, but not the cleaned name', () => {
    const cleaned = cleanProductCategorizations(
      records(product(' Steak\n', ' Beef ', ' steak ')),
      VOCABULARY,
    );

    expect(cleaned).toEqual({
      rows: [{ product: 'Steak', category: 'Beef', cleanedName: ' steak ' }],
      skipped: [],
      rewritten: [],
      refused: [],
    });
  });

  test("strips the product as Python's str.strip does, not as JavaScript's trim", () => {
    const cleaned = cleanProductCategorizations(
      records(product('\x1cSteak\x85', 'Beef'), product('Ham\ufeff', 'Beef')),
      VOCABULARY,
    );

    expect(cleaned.rows.map((row) => row.product)).toEqual(['Steak', 'Ham\ufeff']);
  });

  test('imports a blank cleaned name as null', () => {
    const cleaned = cleanProductCategorizations(
      records(product('Widget', NO_MATCHES_FOUND, ' ')),
      VOCABULARY,
    );

    expect(cleaned.rows).toEqual([
      { product: 'Widget', category: NO_MATCHES_FOUND, cleanedName: null },
    ]);
  });

  test('skips a blank product and a blank category', () => {
    const cleaned = cleanProductCategorizations(
      records(product(' ', 'Beef'), product('Steak', ' ')),
      VOCABULARY,
    );

    expect(cleaned).toEqual({
      rows: [],
      skipped: [
        { line: 2, reason: 'blank product' },
        { line: 3, reason: 'blank category' },
      ],
      rewritten: [],
      refused: [],
    });
  });

  test('keeps the last of a repeated product, telling a changed category from a repeat', () => {
    const cleaned = cleanProductCategorizations(
      records(
        product('Steak', 'Beef', 'old'),
        product('Eggs', 'Beef'),
        product('Steak', 'Beef', 'new'),
        product('Eggs', 'Liquid Eggs'),
      ),
      VOCABULARY,
    );

    expect(cleaned).toEqual({
      rows: [
        { product: 'Steak', category: 'Beef', cleanedName: 'new' },
        { product: 'Eggs', category: 'Liquid Eggs', cleanedName: null },
      ],
      skipped: [
        { line: 2, reason: 'repeated later with the same category' },
        { line: 3, reason: 'repeated later with a different category' },
      ],
      rewritten: [],
      refused: [],
    });
  });

  test('rewrites a category that differs from a known one only in case', () => {
    const cleaned = cleanProductCategorizations(
      records(product('Egg mix', 'liquid eggs')),
      VOCABULARY,
    );

    expect(cleaned).toEqual({
      rows: [{ product: 'Egg mix', category: 'Liquid Eggs', cleanedName: null }],
      skipped: [],
      rewritten: [{ line: 2, reason: 'category "liquid eggs" imported as "Liquid Eggs"' }],
      refused: [],
    });
  });

  test('refuses an unknown category and an over-long product', () => {
    const cleaned = cleanProductCategorizations(
      records(product('Milk', 'Mlik'), product(OVER_LONG_KEY, 'Beef'), product('Steak', 'Beef')),
      VOCABULARY,
    );

    expect(cleaned.refused).toEqual([
      { line: 2, reason: 'unknown category "Mlik"' },
      { line: 3, reason: `key of 2001 bytes, over the ${MAX_CACHE_KEY_BYTES}-byte limit` },
    ]);
  });
});

describe('cleanEntreeClassifications', () => {
  function entree(
    product: string,
    entreeClassification: string,
    cleanedItemNames = '',
  ): Record<EntreeColumn, string> {
    return {
      product,
      entree_classification: entreeClassification,
      cleaned_item_names: cleanedItemNames,
    };
  }

  test('strips the product and imports a blank cleaned name as null', () => {
    const cleaned = cleanEntreeClassifications(
      records(entree(' Burger ', 'entree', 'burger'), entree('Fries', 'side/add-on')),
    );

    expect(cleaned).toEqual({
      rows: [
        { product: 'Burger', classification: 'entree', cleanedName: 'burger' },
        { product: 'Fries', classification: 'side/add-on', cleanedName: null },
      ],
      skipped: [],
      rewritten: [],
      refused: [],
    });
  });

  test('normalizes a label the way the lab does', () => {
    const cleaned = cleanEntreeClassifications(
      records(entree('Burger', '"Entree."'), entree('Fries', 'Side / Add-on')),
    );

    expect(cleaned.rows.map((row) => row.classification)).toEqual(['entree', 'side/add-on']);
    expect(cleaned.rewritten).toEqual([
      { line: 2, reason: 'classification "\\"Entree.\\"" imported as "entree"' },
      { line: 3, reason: 'classification "Side / Add-on" imported as "side/add-on"' },
    ]);
  });

  test('skips a blank product and keeps the last of a repeated one', () => {
    const cleaned = cleanEntreeClassifications(
      records(entree('', 'entree'), entree('Burger', 'side'), entree('Burger', 'entree')),
    );

    expect(cleaned).toEqual({
      rows: [{ product: 'Burger', classification: 'entree', cleanedName: null }],
      skipped: [
        { line: 2, reason: 'blank product' },
        { line: 3, reason: 'repeated later with a different classification' },
      ],
      rewritten: [],
      refused: [],
    });
  });

  test.each(['unsure', ''])('refuses the label %j', (label) => {
    const cleaned = cleanEntreeClassifications(records(entree('Burger', label)));

    expect(cleaned.refused).toEqual([
      { line: 2, reason: `unknown classification ${JSON.stringify(label)}` },
    ]);
  });
});
