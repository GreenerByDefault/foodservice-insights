import { MAX_ORGANIZATION_NAME_LENGTH as DB_MAX_ORGANIZATION_NAME_LENGTH } from '@gbd/db';
import * as v from 'valibot';
import { describe, expect, test } from 'vitest';
import { MAX_ORGANIZATION_NAME_LENGTH, OrganizationNameSchema } from './name.ts';

function parse(name: unknown) {
  return v.safeParse(OrganizationNameSchema, name);
}

test('MAX_ORGANIZATION_NAME_LENGTH mirrors @gbd/db, since this file cannot import it directly', () => {
  expect(MAX_ORGANIZATION_NAME_LENGTH).toBe(DB_MAX_ORGANIZATION_NAME_LENGTH);
});

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

  test('rejects a name over the cap', () => {
    expect(parse('x'.repeat(MAX_ORGANIZATION_NAME_LENGTH + 1)).success).toBe(false);
  });

  test('accepts a name at the cap', () => {
    expect(parse('x'.repeat(MAX_ORGANIZATION_NAME_LENGTH)).success).toBe(true);
  });
});
