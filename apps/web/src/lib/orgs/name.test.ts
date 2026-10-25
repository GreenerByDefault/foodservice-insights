import { MAX_ORGANIZATION_NAME_LENGTH } from '@gbd/db/constraints';
import * as v from 'valibot';
import { describe, expect, test } from 'vitest';
import { OrganizationNameSchema } from './name.ts';

function parse(name: unknown) {
  return v.safeParse(OrganizationNameSchema, name);
}

describe('OrganizationNameSchema', () => {
  test('trims it', () => {
    expect(parse('  Acme Foodservice  ')).toMatchObject({
      success: true,
      output: 'Acme Foodservice',
    });
  });

  test.for([null, '', '   '])('rejects %j as required', (name) => {
    expect(parse(name).success).toBe(false);
  });

  test('rejects a one-character name', () => {
    expect(parse('V').success).toBe(false);
  });

  test('accepts a two-character name', () => {
    expect(parse('Va').success).toBe(true);
  });

  test('rejects a name over the cap', () => {
    expect(parse('x'.repeat(MAX_ORGANIZATION_NAME_LENGTH + 1)).success).toBe(false);
  });

  test('accepts a name at the cap', () => {
    expect(parse('x'.repeat(MAX_ORGANIZATION_NAME_LENGTH)).success).toBe(true);
  });
});
