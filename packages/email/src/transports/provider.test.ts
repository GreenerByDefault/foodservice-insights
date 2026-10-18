import { describe, expect, test } from 'vitest';
import { providerTransport } from './provider.ts';

describe('providerTransport', () => {
  test('resolves every send without sending', async () => {
    await expect(
      providerTransport().send({
        kind: 'gbd-user-deleted',
        from: { address: 'noreply@example.test', name: 'Foodservice Insights' },
        to: 'gbd@example.test',
        subject: 'User deleted',
        text: 'text',
        html: '<p>html</p>',
      }),
    ).resolves.toBeUndefined();
  });
});
