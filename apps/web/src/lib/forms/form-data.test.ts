import { describe, expect, test } from 'vitest';
import { readFile, readText } from './form-data.ts';

describe('readText', () => {
  test('returns the value a field carries, untrimmed', () => {
    const form = new FormData();
    form.set('name', '  Main dining hall  ');

    expect(readText(form, 'name')).toBe('  Main dining hall  ');
  });

  test('returns null for a field the form does not carry', () => {
    expect(readText(new FormData(), 'name')).toBeNull();
  });

  test('returns null when a file arrived where text was expected', () => {
    const form = new FormData();
    form.set('name', new File(['bytes'], 'sneaky.csv'));

    expect(readText(form, 'name')).toBeNull();
  });
});

describe('readFile', () => {
  test('returns the file a field carries', () => {
    const form = new FormData();
    form.set('file', new File(['a,b\n'], 'counts.csv'));

    expect(readFile(form, 'file')).toMatchObject({ name: 'counts.csv', size: 4 });
  });

  test('returns null for a field the form does not carry', () => {
    expect(readFile(new FormData(), 'file')).toBeNull();
  });

  test('returns null when text arrived where a file was expected', () => {
    const form = new FormData();
    form.set('file', 'counts.csv');

    expect(readFile(form, 'file')).toBeNull();
  });

  test('treats an untouched file input as no file rather than an empty one', () => {
    const form = new FormData();
    form.set('file', new File([], ''));

    expect(readFile(form, 'file')).toBeNull();
  });

  test('keeps an empty file that the user did choose', () => {
    const form = new FormData();
    form.set('file', new File([], 'empty.csv'));

    expect(readFile(form, 'file')).toMatchObject({ name: 'empty.csv', size: 0 });
  });
});
