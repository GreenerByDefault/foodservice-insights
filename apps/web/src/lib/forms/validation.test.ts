import * as v from 'valibot';
import { describe, expect, test } from 'vitest';
import { describeIssues, fieldsWithIssues, optionalText, parsedJson } from './validation.ts';

function issuesOf<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  schema: TSchema,
  input: unknown,
): readonly v.BaseIssue<unknown>[] {
  const result = v.safeParse(schema, input);
  if (result.success) throw new Error('expected the input to be rejected');
  return result.issues;
}

describe('optionalText', () => {
  const schema = optionalText(5);

  test.for([
    ['  hello  ', 'hello'],
    ['hello', 'hello'],
    ['   ', null],
    ['', null],
    [null, null],
  ] as const)('%o becomes %o', ([input, expected]) => {
    expect(v.parse(schema, input)).toBe(expected);
  });

  test('rejects text over the cap', () => {
    expect(v.safeParse(schema, 'hello!').success).toBe(false);
  });
});

describe('parsedJson', () => {
  const schema = v.pipe(v.nullable(v.string()), parsedJson);

  test('parses a JSON document', () => {
    expect(v.parse(schema, '{"a":1}')).toEqual({ a: 1 });
  });

  test('reports malformed JSON as an issue rather than throwing', () => {
    expect(describeIssues(issuesOf(schema, '{oops'))).toContain('is not valid JSON');
  });

  test('reports a missing field as required', () => {
    expect(describeIssues(issuesOf(schema, null))).toContain('is required');
  });
});

describe('fieldsWithIssues', () => {
  const schema = v.object({
    name: v.pipe(v.string(), v.maxLength(3)),
    counts: v.record(v.string(), v.number()),
  });

  test('names the top-level field of each issue', () => {
    expect(fieldsWithIssues(issuesOf(schema, { name: 'too long', counts: {} }))).toEqual(['name']);
  });

  test('reports a nested issue against its top-level field', () => {
    expect(fieldsWithIssues(issuesOf(schema, { name: 'ok', counts: { jan: 'lots' } }))).toEqual([
      'counts',
    ]);
  });

  test('lists each field once, however many issues it has', () => {
    const issues = issuesOf(schema, { name: 'too long', counts: { jan: 'lots', feb: 'more' } });

    expect(fieldsWithIssues(issues)).toEqual(['name', 'counts']);
  });

  test('falls back to the form itself for an issue with no path', () => {
    const rootSchema = v.pipe(
      v.string(),
      v.check(() => false, 'nope'),
    );

    expect(fieldsWithIssues(issuesOf(rootSchema, 'anything'))).toEqual(['the form']);
  });
});

describe('describeIssues', () => {
  test('pairs each path with its message', () => {
    const schema = v.object({ name: v.pipe(v.string(), v.maxLength(3, 'is too long')) });

    expect(describeIssues(issuesOf(schema, { name: 'too long' }))).toBe('name: is too long');
  });

  test('joins several issues', () => {
    const schema = v.object({
      name: v.pipe(v.string(), v.maxLength(3, 'is too long')),
      siteName: v.pipe(v.string(), v.maxLength(3, 'is too long')),
    });

    expect(describeIssues(issuesOf(schema, { name: 'too long', siteName: 'also too long' }))).toBe(
      'name: is too long; siteName: is too long',
    );
  });

  test('describes a pathless issue as the root', () => {
    const schema = v.pipe(
      v.string(),
      v.check(() => false, 'nope'),
    );

    expect(describeIssues(issuesOf(schema, 'anything'))).toBe('<root>: nope');
  });
});
