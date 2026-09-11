import * as v from 'valibot';
import { describe, expect, test } from 'vitest';
import { parseBody } from './body.ts';

describe('parseBody', () => {
  const schema = v.object({ role: v.picklist(['admin', 'member']) });

  test('returns the parsed value for a body matching the schema', () => {
    expect(parseBody(schema, { role: 'admin' })).toEqual({
      ok: true,
      value: { role: 'admin' },
    });
  });

  test('returns a 400 with the standard message for a body that fails the schema', async () => {
    const result = parseBody(schema, { role: 'owner' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ message: 'Fix the highlighted field.' });
  });
});
