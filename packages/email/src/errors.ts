/** What an email failure is. */

/** A request to the email service failed: the endpoint unreachable, a timeout, a rejected key, a
 * recipient the service refused.
 *
 * Every request this package makes is wrapped so that its failures leave here under this one type,
 * which is what lets a caller tell an outage apart from a bug in its own code with an `instanceof`.
 *
 * Whatever the transport raised is kept as `cause`, which is the only thing that says why.
 */
export class EmailError extends Error {
  override readonly name = 'EmailError';
}

/** Whether an error means email failed, rather than the code that called it. */
export function isEmailError(error: unknown): error is EmailError {
  return error instanceof EmailError;
}

/** Await one request to the email service, relabelling whatever it fails with.
 *
 * Wrap the request and nothing else. What this turns into an `EmailError` is a request failing, so
 * anything else inside the callback — rendering the message, shaping the body — would be reported
 * as an outage when it is a bug.
 */
export async function emailRequest<T>(operation: string, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (cause) {
    throw new EmailError(`${operation} failed`, { cause });
  }
}
