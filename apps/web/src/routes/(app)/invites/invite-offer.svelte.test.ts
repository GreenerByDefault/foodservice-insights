import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { goto, invalidateAll } from '$app/navigation';
import { expectFetched, jsonResponse, stubFetch, stubPendingFetch } from '$lib/testing/fetch';
import { resetNavigationMocks } from '$lib/testing/navigation';
import { resetToastMocks, toast } from '$lib/testing/toast';
import InviteOffer from './invite-offer.svelte';
import { anInviteOffer } from './testing/fixtures.ts';

vi.mock('$app/navigation', () => import('$lib/testing/navigation'));
vi.mock('svelte-sonner', () => import('$lib/testing/toast'));

afterEach(() => {
  vi.unstubAllGlobals();
  resetNavigationMocks();
  resetToastMocks();
});

describe('InviteOffer', () => {
  describe('a live invite', () => {
    test('names the inviter, the role and the deadline', async () => {
      const screen = await render(InviteOffer, { invite: anInviteOffer({ role: 'admin' }) });

      await expect
        .element(screen.getByRole('heading', { name: 'Northgate Provisions' }))
        .toBeVisible();
      await expect
        .element(screen.getByText('Priya Shah invited you to join as an admin.'))
        .toBeVisible();
      await expect.element(screen.getByText('Expires in 3 days')).toBeVisible();
    });

    test('an inviter with no name reads "An admin"', async () => {
      const screen = await render(InviteOffer, { invite: anInviteOffer({ invitedByName: null }) });

      await expect
        .element(screen.getByText('An admin invited you to join as a member.'))
        .toBeVisible();
    });

    test('accepting POSTs the invite, goes to the organization reloading everything, and toasts', async () => {
      const fetchMock = stubFetch(jsonResponse({ organizationSlug: 'northgate' }));
      const invite = anInviteOffer();
      const screen = await render(InviteOffer, { invite });

      await screen
        .getByRole('button', { name: 'Accept invitation to Northgate Provisions' })
        .click();

      await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
      expect(goto).toHaveBeenCalledWith('/orgs/northgate', { invalidateAll: true });
      expectFetched(fetchMock, { url: `/api/invites/${invite.inviteId}/accept`, method: 'POST' });
      await expect
        .poll(() => toast.success.mock.calls)
        .toEqual([['You joined Northgate Provisions']]);
    });

    test.for([
      ['an expired', 410, 'expired'],
      ['a no-longer-valid', 409, 'no-longer-valid'],
    ] as const)(
      '%s answer reloads the stale list rather than showing an error',
      async ([, status, code]) => {
        stubFetch(jsonResponse({ message: 'Nope', code }, status));
        const screen = await render(InviteOffer, { invite: anInviteOffer() });

        await screen
          .getByRole('button', { name: 'Accept invitation to Northgate Provisions' })
          .click();

        await expect.poll(() => vi.mocked(invalidateAll).mock.calls.length).toBe(1);
        expect(goto).not.toHaveBeenCalled();
        await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
        expect(toast.success).not.toHaveBeenCalled();
      },
    );

    test('a failed accept shows an error and navigates nowhere', async () => {
      stubFetch(jsonResponse({ message: 'Nope' }, 500));
      const screen = await render(InviteOffer, { invite: anInviteOffer() });

      await screen
        .getByRole('button', { name: 'Accept invitation to Northgate Provisions' })
        .click();

      await expect
        .element(screen.getByText("Couldn't accept this invitation — please try again."))
        .toBeVisible();
      expect(goto).not.toHaveBeenCalled();
      expect(invalidateAll).not.toHaveBeenCalled();
    });

    test('both buttons are disabled while an answer is in flight', async () => {
      stubPendingFetch();
      const screen = await render(InviteOffer, { invite: anInviteOffer() });
      const accept = screen.getByRole('button', {
        name: 'Accept invitation to Northgate Provisions',
      });
      const decline = screen.getByRole('button', {
        name: 'Decline invitation to Northgate Provisions',
      });

      await accept.click();

      await expect.element(accept).toBeDisabled();
      await expect.element(accept).toHaveAttribute('aria-busy', 'true');
      await expect.element(decline).toBeDisabled();
      await expect.element(decline).toHaveAttribute('aria-busy', 'false');
    });

    test('declining POSTs the invite, reloads the list and toasts', async () => {
      const fetchMock = stubFetch(new Response(null, { status: 204 }));
      const invite = anInviteOffer();
      const screen = await render(InviteOffer, { invite });

      await screen
        .getByRole('button', { name: 'Decline invitation to Northgate Provisions' })
        .click();

      await expect.poll(() => vi.mocked(invalidateAll).mock.calls.length).toBe(1);
      expectFetched(fetchMock, { url: `/api/invites/${invite.inviteId}/decline`, method: 'POST' });
      await expect
        .poll(() => toast.success.mock.calls)
        .toEqual([['Declined the invitation to Northgate Provisions']]);
    });

    test('a declined invite that was no longer valid reloads the list too', async () => {
      stubFetch(jsonResponse({ message: 'Nope', code: 'no-longer-valid' }, 409));
      const screen = await render(InviteOffer, { invite: anInviteOffer() });

      await screen
        .getByRole('button', { name: 'Decline invitation to Northgate Provisions' })
        .click();

      await expect.poll(() => vi.mocked(invalidateAll).mock.calls.length).toBe(1);
    });

    test('a failed decline shows an error and reloads nothing', async () => {
      stubFetch(jsonResponse({ message: 'Nope' }, 500));
      const screen = await render(InviteOffer, { invite: anInviteOffer() });

      await screen
        .getByRole('button', { name: 'Decline invitation to Northgate Provisions' })
        .click();

      await expect
        .element(screen.getByText("Couldn't decline this invitation — please try again."))
        .toBeVisible();
      expect(invalidateAll).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });
  });

  describe('an expired invite', () => {
    test('says when it ran out, and offers only Dismiss', async () => {
      const screen = await render(InviteOffer, { invite: anInviteOffer({ isExpired: true }) });

      await expect
        .element(
          screen.getByText(
            'Your invitation expired 2 days ago. Ask an admin there to send a new one.',
          ),
        )
        .toBeVisible();
      await expect.element(screen.getByRole('button', { name: /^Accept/ })).not.toBeInTheDocument();
      await expect
        .element(screen.getByRole('button', { name: /^Decline/ }))
        .not.toBeInTheDocument();
    });

    test('dismissing POSTs a decline, reloads the list and toasts', async () => {
      const fetchMock = stubFetch(new Response(null, { status: 204 }));
      const invite = anInviteOffer({ isExpired: true });
      const screen = await render(InviteOffer, { invite });

      await screen
        .getByRole('button', { name: 'Dismiss invitation to Northgate Provisions' })
        .click();

      await expect.poll(() => vi.mocked(invalidateAll).mock.calls.length).toBe(1);
      expectFetched(fetchMock, { url: `/api/invites/${invite.inviteId}/decline`, method: 'POST' });
      await expect
        .poll(() => toast.success.mock.calls)
        .toEqual([['Dismissed the invitation to Northgate Provisions']]);
    });

    test('a failed dismiss says so', async () => {
      stubFetch(jsonResponse({ message: 'Nope' }, 500));
      const screen = await render(InviteOffer, { invite: anInviteOffer({ isExpired: true }) });

      await screen
        .getByRole('button', { name: 'Dismiss invitation to Northgate Provisions' })
        .click();

      await expect
        .element(screen.getByText("Couldn't dismiss this invitation — please try again."))
        .toBeVisible();
    });
  });
});
