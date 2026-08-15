/** An `Emailer` that renders for real and keeps the result instead of sending it.
 *
 * This is what `apps/worker` and `apps/web` tests use. They are testing *that the right email was
 * asked for at the right moment*, not what it says — so they assert on `kind` and `to`, and leave
 * the copy to this package's own tests.
 *
 * Rendering is real, not stubbed, which is the point: a message a renderer would throw on fails
 * here too, rather than in production long after the test went green.
 */

import type { Emailer, EmailerConfig, EmailTransport, RenderedEmail } from '../client.ts';
import { initializeEmailer } from '../client.ts';

export type RecordingEmailer = {
  readonly service: Emailer;
  /** Everything sent so far, oldest first. */
  sent(): readonly RenderedEmail[];
  clear(): void;
};

/** Addresses under `.test`, which is reserved by RFC 2606 and so can never be a real recipient. */
const DEFAULTS = {
  from: 'Foodservice Insights <noreply@example.test>',
  siteUrl: 'https://example.test',
  gbdAddress: 'gbd@example.test',
} as const;

export function recordingEmailer(
  overrides: Partial<Omit<EmailerConfig, 'transport'>> = {},
): RecordingEmailer {
  const sent: RenderedEmail[] = [];

  const transport: EmailTransport = {
    name: 'recording',
    send(email: RenderedEmail): Promise<void> {
      sent.push(email);
      return Promise.resolve();
    },
  };

  return {
    service: initializeEmailer({ ...DEFAULTS, ...overrides, transport }),
    sent: () => sent,
    clear: () => {
      sent.length = 0;
    },
  };
}
