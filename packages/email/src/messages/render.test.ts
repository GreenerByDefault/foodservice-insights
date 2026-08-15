/** `render` across the whole union — who each message goes to, and what every message owes
 * regardless of kind. What each one *says* is tested beside its own renderer.
 */

import { describe, expect, test } from 'vitest';
import type { EmailMessageKind } from '../client.ts';
import { recordingEmailer } from '../testing/recording.ts';
import { sampleMessages } from '../testing/samples.ts';
import { render } from './index.ts';

const emailer = recordingEmailer().service;
const RECIPIENT = 'alice@example.test';

const GBD_KINDS: ReadonlySet<EmailMessageKind> = new Set([
  'gbd-organization-created',
  'gbd-organization-deleted',
  'gbd-user-deleted',
]);

describe('render', () => {
  test.each(sampleMessages(RECIPIENT).map((message) => [message.kind, message] as const))(
    '%s carries both bodies, its own kind, and the configured sender',
    (kind, message) => {
      const email = render(emailer, message);

      expect(email).toMatchObject({ kind, from: emailer.from });
      expect(email.subject).not.toHaveLength(0);
      expect(email.text).not.toHaveLength(0);
      expect(email.html).toContain('<!doctype html>');
    },
  );

  test.each(sampleMessages(RECIPIENT).map((message) => [message.kind, message] as const))(
    '%s goes to the address its event is about',
    (kind, message) => {
      expect(render(emailer, message).to).toBe(
        GBD_KINDS.has(kind) ? emailer.gbdAddress : RECIPIENT,
      );
    },
  );

  test('uses one string for the subject and the heading', () => {
    const [succeeded] = sampleMessages(RECIPIENT);
    if (succeeded === undefined) throw new Error('no sample messages');

    const email = render(emailer, succeeded);
    expect(email.html).toContain(`<title>${email.subject}</title>`);
  });

  test('builds links against the emailer, not the message', () => {
    const elsewhere = recordingEmailer({ siteUrl: 'https://staging.example.test/' }).service;
    const [succeeded] = sampleMessages(RECIPIENT);
    if (succeeded === undefined) throw new Error('no sample messages');

    // The trailing slash is trimmed by `initializeEmailer`, so this is one slash, not two.
    expect(render(elsewhere, succeeded).text).toContain('https://staging.example.test/orgs/');
  });
});
