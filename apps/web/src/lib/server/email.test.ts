import { expect, test, vi } from 'vitest';
import { emailer, notifyGbd } from './email.ts';

test('returns the same handle every time, so the app holds one client', () => {
  expect(emailer()).toBe(emailer());
});

test('notifyGbd sends through the app handle on success', async () => {
  const sent = vi.spyOn(emailer().transport, 'send').mockResolvedValue(undefined);

  try {
    await notifyGbd({
      kind: 'gbd-organization-created',
      organizationName: 'Acme Foodservice',
      actorEmail: 'dana@example.test',
    });

    expect(sent).toHaveBeenCalledTimes(1);
  } finally {
    sent.mockRestore();
  }
});

test('notifyGbd logs, rather than throws, when the send fails', async () => {
  const sent = vi.spyOn(emailer().transport, 'send').mockRejectedValue(new Error('boom'));
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await expect(
      notifyGbd({
        kind: 'gbd-organization-created',
        organizationName: 'Acme Foodservice',
        actorEmail: 'dana@example.test',
      }),
    ).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledTimes(1);
    const [message, meta] = logged.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('Could not notify GBD');
    expect(meta).toMatchObject({ kind: 'gbd-organization-created' });
  } finally {
    sent.mockRestore();
    logged.mockRestore();
  }
});
