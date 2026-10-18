/** **Stub:** what production selects until it switches to `postmark`
 * (`.claude/plans/email-provider.md`).
 *
 * Every send is dropped as if it went out. A send that failed instead would put every invite on its
 * "saved, but the email failed" path, and burn every analysis notification's retries, for a gap that
 * is known and temporary.
 */

import type { EmailTransport } from '../client.ts';

export function providerTransport(): EmailTransport {
  return {
    name: 'provider',
    send(): Promise<void> {
      return Promise.resolve();
    },
  };
}
