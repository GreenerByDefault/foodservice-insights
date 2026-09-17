import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { jsonResponse, stubFetch } from '$lib/testing/fetch';
import PendingInviteRow from './pending-invite-row.svelte';
import { aPendingInvite } from './testing/fixtures.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PendingInviteRow', () => {
  test('a live invite shows its role and a future-facing expiry', async () => {
    const invite = aPendingInvite({ role: 'admin', isExpired: false });
    const screen = await render(PendingInviteRow, {
      organizationSlug: 'org-1',
      invite,
      onRevoked: vi.fn(),
    });

    await expect.element(screen.getByText(invite.email)).toBeVisible();
    await expect.element(screen.getByText('Admin', { exact: false })).toBeVisible();
    await expect.element(screen.getByText('in 3 days', { exact: false })).toBeVisible();
  });

  test('an expired invite reads "Expired" rather than a countdown', async () => {
    const invite = aPendingInvite({ isExpired: true });
    const screen = await render(PendingInviteRow, {
      organizationSlug: 'org-1',
      invite,
      onRevoked: vi.fn(),
    });

    await expect.element(screen.getByText('Expired', { exact: false })).toBeVisible();
  });

  test('revoking DELETEs the invite and calls onRevoked', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    const onRevoked = vi.fn().mockResolvedValue(undefined);
    const invite = aPendingInvite();
    const screen = await render(PendingInviteRow, { organizationSlug: 'org-1', invite, onRevoked });

    await screen.getByRole('button', { name: `Revoke invite for ${invite.email}` }).click();

    await expect.poll(() => onRevoked.mock.calls.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `/api/orgs/org-1/invites/${invite.inviteId}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  test('a failed revoke shows a generic error and does not call onRevoked', async () => {
    stubFetch(jsonResponse({ message: 'Not found', code: 'not_found' }, 404));
    const onRevoked = vi.fn().mockResolvedValue(undefined);
    const invite = aPendingInvite();
    const screen = await render(PendingInviteRow, { organizationSlug: 'org-1', invite, onRevoked });

    await screen.getByRole('button', { name: `Revoke invite for ${invite.email}` }).click();

    await expect
      .element(screen.getByText("Couldn't revoke this invite — please try again."))
      .toBeVisible();
    expect(onRevoked).not.toHaveBeenCalled();
  });
});
