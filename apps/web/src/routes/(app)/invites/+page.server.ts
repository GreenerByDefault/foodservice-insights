import type { PageServerLoad } from './$types';

/** **Stub:** loads nothing yet. It will return the invites waiting for this user's verified
 * address, matched on the email in `auth`.
 *
 * Work out each invite's status in SQL from `expires_at` against the database's clock rather than
 * trusting the stored `status`, so that a `load` never writes.
 *
 * **Open:** nothing moves a pending invite to `expired` if nobody ever opens this page. Reads
 * compute the effective status, so the UI is right either way; a sweep can come later.
 */
export const load: PageServerLoad = () => ({});
