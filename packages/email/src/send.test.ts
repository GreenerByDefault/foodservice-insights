import { describe, expect, test } from 'vitest';
import { isEmailError } from './errors.ts';
import { sendEmail } from './send.ts';
import { allMessages, anAnalysisSucceeded } from './testing/fixtures.ts';
import { recordingEmailer } from './testing/recording.ts';
import { unreachableEmailer } from './testing/unreachable.ts';

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

  test('fails with an EmailError when the service cannot be reached', async () => {
    const thrown = await sendEmail(unreachableEmailer(), anAnalysisSucceeded()).catch(
      (error: unknown) => error,
    );

    expect(isEmailError(thrown)).toBe(true);
    // The reason a send failed only ever lives on `cause`.
    expect((thrown as Error).cause).toBeDefined();
  });
});
