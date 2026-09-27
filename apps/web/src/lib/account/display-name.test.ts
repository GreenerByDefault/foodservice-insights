import { MAX_DISPLAY_NAME_LENGTH as DB_MAX_DISPLAY_NAME_LENGTH } from '@gbd/db';
import * as v from 'valibot';
import { describe, expect, test } from 'vitest';
import { DisplayNameSchema, MAX_DISPLAY_NAME_LENGTH } from './display-name.ts';

function parse(name: unknown) {
  return v.safeParse(DisplayNameSchema, name);
}

test('MAX_DISPLAY_NAME_LENGTH mirrors @gbd/db, since this file cannot import it directly', () => {
  expect(MAX_DISPLAY_NAME_LENGTH).toBe(DB_MAX_DISPLAY_NAME_LENGTH);
});

describe('DisplayNameSchema', () => {
  test('trims it', () => {
    expect(parse('  Sam Cook  ')).toMatchObject({ success: true, output: 'Sam Cook' });
  });

  test.for([null, '', '   '])('rejects %j as required', (name) => {
    expect(parse(name).success).toBe(false);
  });

  test('rejects a name over the cap', () => {
    expect(parse('x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1)).success).toBe(false);
  });

  test('accepts a name at the cap', () => {
    expect(parse('x'.repeat(MAX_DISPLAY_NAME_LENGTH)).success).toBe(true);
  });
});
