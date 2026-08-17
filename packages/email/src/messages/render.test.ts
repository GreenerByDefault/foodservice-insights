/** `render` across the whole union — who each message goes to, and what every message owes
 * regardless of kind. What each one *says* is tested beside its own renderer.
 */

import { describe, expect, test } from 'vitest';
import { aGbdOrganizationCreated, allMessages, anAnalysisSucceeded } from '../testing/fixtures.ts';
import { recordingEmailer } from '../testing/recording.ts';
import { render } from './index.ts';
import { reportUrl } from './links.ts';

const emailer = recordingEmailer().service;
const RECIPIENT = 'alice@example.test';

describe('render', () => {
  test.each(allMessages(RECIPIENT).map((message) => [message.kind, message] as const))(
    '%s carries both bodies, its own kind, and the configured sender',
    (kind, message) => {
      const email = render(emailer, message);

      expect(email).toMatchObject({ kind, from: emailer.from });
      expect(email.subject).not.toHaveLength(0);
      expect(email.text).not.toHaveLength(0);
      expect(email.html).toContain('<!doctype html>');
    },
  );

  test.each(allMessages(RECIPIENT))('$kind goes to the address its event is about', (message) => {
    // GBD notices carry no `to` at all (see messages/gbd.ts) — that absence, not a
    // hand-copied list of kinds, is what tells us where each one should land.
    const expected = 'to' in message ? message.to : emailer.gbdAddress;
    expect(render(emailer, message).to).toBe(expected);
  });

  test('defaults the subject to the document heading, as a convenience — not a rule the type enforces', () => {
    const email = render(emailer, anAnalysisSucceeded({ to: RECIPIENT }));
    expect(email.html).toContain(`<title>${email.subject}</title>`);
  });

  test('builds links from the siteUrl passed in, not a cached default', () => {
    const otherEmailer = recordingEmailer({ siteUrl: 'https://staging.example.test' }).service;
    const succeeded = anAnalysisSucceeded({ to: RECIPIENT });
    expect(render(otherEmailer, succeeded).text).toContain(
      reportUrl(otherEmailer, succeeded.organizationId, succeeded.reportId),
    );
  });

  test('addresses a GBD notice using the emailer’s gbdAddress, not a cached default', () => {
    const otherEmailer = recordingEmailer({ gbdAddress: 'ops@example.test' }).service;
    expect(render(otherEmailer, aGbdOrganizationCreated()).to).toBe('ops@example.test');
  });
});
