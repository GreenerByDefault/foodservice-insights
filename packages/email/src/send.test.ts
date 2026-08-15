import { describe, expect, test } from 'vitest';
import { initializeEmailer } from './client.ts';
import { isEmailError } from './errors.ts';
import { sendEmail } from './send.ts';
import { recordingEmailer } from './testing/recording.ts';
import { sampleMessages } from './testing/samples.ts';
import { providerTransport } from './transports/provider.ts';

const [SUCCEEDED] = sampleMessages('alice@example.test');
if (SUCCEEDED === undefined) throw new Error('no sample messages');

describe('sendEmail', () => {
  test('hands the rendered email to the transport', async () => {
    const recording = recordingEmailer();
    await sendEmail(recording.service, SUCCEEDED);

    expect(recording.sent()).toMatchObject([
      { kind: 'analysis-succeeded', to: 'alice@example.test' },
    ]);
  });

  test('records in the order sent', async () => {
    const recording = recordingEmailer();
    for (const message of sampleMessages('alice@example.test')) {
      await sendEmail(recording.service, message);
    }

    expect(recording.sent().map((email) => email.kind)).toEqual([
      'analysis-succeeded',
      'analysis-failed',
      'organization-invite',
      'gbd-organization-created',
      'gbd-organization-deleted',
      'gbd-user-deleted',
    ]);
  });

  test('fails with an EmailError, not a crash, while no provider is configured', async () => {
    const emailer = initializeEmailer({
      transport: providerTransport(),
      from: 'Foodservice Insights <noreply@example.test>',
      siteUrl: 'https://example.test',
      gbdAddress: 'gbd@example.test',
    });

    const thrown = await sendEmail(emailer, SUCCEEDED).catch((error: unknown) => error);

    expect(isEmailError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain('EMAIL_TRANSPORT');
  });
});
