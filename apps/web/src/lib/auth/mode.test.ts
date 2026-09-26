import { describe, expect, test } from 'vitest';
import { parseAuthMode } from './mode.ts';

describe('parseAuthMode', () => {
  test.each(['placeholder', 'supabase'] as const)('accepts %s', (mode) => {
    expect(parseAuthMode(mode)).toBe(mode);
  });

  test('refuses an unset value, naming both modes', () => {
    expect(() => parseAuthMode(undefined)).toThrow(
      'PUBLIC_AUTH_MODE is not set. Expected one of: placeholder, supabase. See .env.example.',
    );
  });

  test('treats an empty value as unset', () => {
    expect(() => parseAuthMode('')).toThrow('PUBLIC_AUTH_MODE is not set.');
  });

  test('refuses an unknown value, naming it and both modes', () => {
    expect(() => parseAuthMode('Supabase')).toThrow(
      "Unknown PUBLIC_AUTH_MODE 'Supabase'. Expected one of: placeholder, supabase. See .env.example.",
    );
  });
});
