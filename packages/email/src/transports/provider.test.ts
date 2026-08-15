import { describe, expect, test } from 'vitest';
import { isEmailError } from '../errors.ts';
import { providerTransport } from './provider.ts';

describe('providerTransport', () => {
  test('rejects every send with an EmailError naming EMAIL_TRANSPORT', async () => {
    const thrown = await providerTransport()
      .send({
        kind: 'gbd-user-deleted',
        from: 'Foodservice Insights <noreply@example.test>',
        to: 'gbd@example.test',
        subject: 'User deleted',
        text: 'text',
        html: '<p>html</p>',
      })
      .catch((error: unknown) => error);

    expect(isEmailError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain('EMAIL_TRANSPORT');
  });
});
