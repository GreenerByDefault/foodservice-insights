import { expect, test, vi } from 'vitest';
import { emailer, notifyGbd, sendInvite } from './email.ts';

const AN_INVITE = {
  kind: 'organization-invite',
  to: 'ada@example.test',
  organizationName: 'Acme Foodservice',
  role: 'member',
  invitedByName: 'Dana',
  expiresAt: new Date('2026-01-15T00:00:00Z'),
} as const;

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

test('sendInvite reports success as true', async () => {
  const sent = vi.spyOn(emailer().transport, 'send').mockResolvedValue(undefined);

  try {
    await expect(sendInvite(AN_INVITE)).resolves.toBe(true);
  } finally {
    sent.mockRestore();
  }
});

test('sendInvite logs and reports false, rather than throwing, when the send fails', async () => {
  const sent = vi.spyOn(emailer().transport, 'send').mockRejectedValue(new Error('boom'));
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await expect(sendInvite(AN_INVITE)).resolves.toBe(false);

    expect(logged).toHaveBeenCalledTimes(1);
    const [message, meta] = logged.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('Could not send invite');
    expect(meta).toMatchObject({ to: AN_INVITE.to });
  } finally {
    sent.mockRestore();
    logged.mockRestore();
  }
});
