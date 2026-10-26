import { ORGANIZATION_SLUG_PATTERN } from '@gbd/db/constraints';
import { defineParams } from '@sveltejs/kit/params';
import * as v from 'valibot';

export const params = defineParams({
  /** An organization slug, as `[organizationSlug=slug]`. */
  slug: v.pipe(v.string(), v.regex(ORGANIZATION_SLUG_PATTERN)),

  /** A UUID, as `[id=uuid]`. Without it, `/file/input/nonsense` reaches Postgres and comes back as
   * `22P02 invalid input syntax for type uuid` — a 500 where the honest answer is a 404.
   */
  uuid: v.pipe(v.string(), v.uuid()),
});
