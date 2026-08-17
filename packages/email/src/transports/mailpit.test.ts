/** Proves the transport end-to-end, against the real Mailpit the test stack runs. */

import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import { describe, expect, test } from 'vitest';
import { initializeEmailer } from '../client.ts';
import { isEmailError } from '../errors.ts';
import { sendEmail } from '../send.ts';
import { breakableEmailer } from '../testing/breakable.ts';
import { allMessages, anAnalysisSucceeded } from '../testing/fixtures.ts';
import { aTestEmailAddress, waitForEmail, waitForEmails } from '../testing/mailbox.ts';
import { mailpitTransport } from './mailpit.ts';

loadLocalEnv();

const FROM = { address: 'noreply@example.test', name: 'Foodservice Insights' };

function emailerForTests(overrides: { gbdAddress?: string } = {}) {
  return initializeEmailer({
    transport: mailpitTransport({ endpoint: requireEnv('EMAIL_ENDPOINT') }),
    from: FROM,
    siteUrl: 'https://example.test',
    gbdAddress: aTestEmailAddress('gbd'),
    supportAddress: 'support@example.test',
    ...overrides,
  });
}

/** An emailer whose GBD notices are also addressed to `mailbox`, so a test sending every
 * message kind can poll one mailbox instead of tracking each kind's real recipient. */
function emailerWithSharedMailbox(mailbox: string) {
  return emailerForTests({ gbdAddress: mailbox });
}

describe('mailpitTransport', () => {
  test('delivers both bodies, the subject, and the parsed sender', async () => {
    const to = aTestEmailAddress();
    const emailer = emailerForTests();

    await sendEmail(emailer, anAnalysisSucceeded({ to }));

    const delivered = await waitForEmail(to);
    expect(delivered).toMatchObject({
      from: 'noreply@example.test',
      to: [to],
      subject: 'Your report is ready: Q1 procurement',
    });
    expect(delivered.text).toContain('We have finished analysing your procurement data.');
    expect(delivered.html).toContain('<h1');
  });

  test('delivers every message we can send', async () => {
    const to = aTestEmailAddress();
    const emailer = emailerWithSharedMailbox(to);

    const messages = allMessages(to);
    for (const message of messages) await sendEmail(emailer, message);

    const delivered = await waitForEmails(to, messages.length);
    expect(delivered.map((email) => email.subject)).toHaveLength(messages.length);
  });

  test('fails with an EmailError when Mailpit rejects the request', async () => {
    const emailer = emailerForTests();

    const thrown = await sendEmail(emailer, anAnalysisSucceeded({ to: 'not-an-email' })).catch(
      (error: unknown) => error,
    );

    expect(isEmailError(thrown)).toBe(true);
  });

  test('fails with an EmailError when Mailpit goes away, and recovers when it comes back', async () => {
    const to = aTestEmailAddress();
    const breakable = breakableEmailer();
    const succeeded = anAnalysisSucceeded({ to });

    try {
      breakable.break();
      const thrown = await sendEmail(breakable.service, succeeded).catch((error: unknown) => error);
      expect(isEmailError(thrown)).toBe(true);

      breakable.restore();
      await sendEmail(breakable.service, succeeded);
      expect(await waitForEmail(to)).toMatchObject({ to: [to] });
    } finally {
      await breakable.close();
    }
  });

  test('waitForEmails throws when too few arrive before the timeout', async () => {
    const to = aTestEmailAddress();
    const emailer = emailerForTests();

    await sendEmail(emailer, anAnalysisSucceeded({ to }));

    await expect(waitForEmails(to, 2, { timeoutMs: 200, pollIntervalMs: 20 })).rejects.toThrow(
      'Only 1 of 2 emails arrived',
    );
  });
});
