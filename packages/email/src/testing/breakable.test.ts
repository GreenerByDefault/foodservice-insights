import { describe, expect, test } from 'vitest';
import { isEmailError } from '../errors.ts';
import { sendEmail } from '../send.ts';
import { breakableEmailer } from './breakable.ts';
import { anAnalysisSucceeded } from './fixtures.ts';
import { aTestEmailAddress, waitForEmail } from './mailbox.ts';

describe('breakableEmailer', () => {
  test('a broken transport fails as an EmailError, and a restored one delivers', async () => {
    const to = aTestEmailAddress();
    const breakable = breakableEmailer();
    const message = anAnalysisSucceeded({ to });
    try {
      breakable.break();
      const failure = await sendEmail(breakable.service, message).catch((error: unknown) => error);

      expect(isEmailError(failure)).toBe(true);

      breakable.restore();
      await sendEmail(breakable.service, message);
      expect(await waitForEmail(to)).toMatchObject({ to: [to] });
    } finally {
      await breakable.close();
    }
  });
});
