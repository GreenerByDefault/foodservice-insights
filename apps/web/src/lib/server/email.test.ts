import { expect, test, vi } from 'vitest';
import { emailer, notifyGbd, sendInvite } from './email.ts';
import { SERVER_LOGS } from './testing/logs.ts';

const AN_INVITE_ID = crypto.randomUUID();

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

  try {
    await expect(
      notifyGbd({
        kind: 'gbd-organization-created',
        organizationName: 'Acme Foodservice',
        actorEmail: 'dana@example.test',
      }),
    ).resolves.toBeUndefined();

    expect(SERVER_LOGS.records).toEqual([
      {
        level: 'error',
        msg: 'Could not notify GBD',
        kind: 'gbd-organization-created',
        err: expect.objectContaining({ type: 'Error', message: 'boom' }),
      },
    ]);
  } finally {
    sent.mockRestore();
  }
});

test('sendInvite reports success as true', async () => {
  const sent = vi.spyOn(emailer().transport, 'send').mockResolvedValue(undefined);

  try {
    await expect(sendInvite(AN_INVITE_ID, AN_INVITE)).resolves.toBe(true);
  } finally {
    sent.mockRestore();
  }
});

test('sendInvite logs and reports false, rather than throwing, when the send fails', async () => {
  const sent = vi.spyOn(emailer().transport, 'send').mockRejectedValue(new Error('boom'));

  try {
    await expect(sendInvite(AN_INVITE_ID, AN_INVITE)).resolves.toBe(false);

    expect(SERVER_LOGS.records).toEqual([
      {
        level: 'error',
        msg: 'Could not send invite',
        inviteId: AN_INVITE_ID,
        err: expect.objectContaining({ type: 'Error', message: 'boom' }),
      },
    ]);
  } finally {
    sent.mockRestore();
  }
});
