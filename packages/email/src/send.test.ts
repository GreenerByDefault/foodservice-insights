import { describe, expect, test } from 'vitest';
import { sendEmail } from './send.ts';
import { allMessages, anAnalysisSucceeded } from './testing/fixtures.ts';
import { recordingEmailer } from './testing/recording.ts';

describe('sendEmail', () => {
  test('hands the rendered email to the transport', async () => {
    const recording = recordingEmailer();
    await sendEmail(recording.service, anAnalysisSucceeded());

    expect(recording.sent()).toMatchObject([
      { kind: 'analysis-succeeded', to: 'alice@example.test' },
    ]);
  });

  test('records in the order sent', async () => {
    const recording = recordingEmailer();
    const messages = allMessages('alice@example.test');
    for (const message of messages) {
      await sendEmail(recording.service, message);
    }

    expect(recording.sent().map((email) => email.kind)).toEqual(
      messages.map((message) => message.kind),
    );
  });
});
