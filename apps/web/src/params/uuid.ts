import type { ParamMatcher } from '@sveltejs/kit';
import * as v from 'valibot';

const UuidSchema = v.pipe(v.string(), v.uuid());

/** Constrain a route parameter to a UUID, as `[id=uuid]`.
 *
 * Without it, `/file/input/nonsense` or `/reports/nonsense` reaches Postgres and comes back as
 * `22P02 invalid input syntax for type uuid` — a 500 where the honest answer is a 404. SvelteKit
 * does not match the route at all when this returns false.
 */
export const match: ParamMatcher = (param) => v.is(UuidSchema, param);
