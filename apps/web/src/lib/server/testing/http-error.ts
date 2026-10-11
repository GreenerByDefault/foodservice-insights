import { isHttpError } from '@sveltejs/kit';

/** The status and code SvelteKit would send for `error(...)` thrown (or rejected) by `call`, or a
 * failure if it did not throw at all. Covers both a guard called directly and a `load` awaited
 * for its result, since `await` inside the `try` catches a synchronous throw or a rejection alike.
 */
export async function statusOf(call: () => unknown): Promise<{ status: number; code?: string }> {
  try {
    await call();
  } catch (thrown) {
    if (isHttpError(thrown)) return { status: thrown.status, code: thrown.body.code };
    throw thrown;
  }
  throw new Error('Expected an error() to be thrown, but nothing was.');
}
