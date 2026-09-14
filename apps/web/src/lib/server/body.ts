/** Parsing a JSON request body against a valibot schema, with the 400 every route answers a bad
 * one with. */

import { json } from '@sveltejs/kit';
import * as v from 'valibot';

export function parseBody<T>(
  schema: v.GenericSchema<unknown, T>,
  body: unknown,
): { ok: true; value: T } | { ok: false; response: Response } {
  const parsed = v.safeParse(schema, body);
  if (!parsed.success) {
    return {
      ok: false,
      response: json({ message: 'Fix the highlighted field.' }, { status: 400 }),
    };
  }
  return { ok: true, value: parsed.output };
}
