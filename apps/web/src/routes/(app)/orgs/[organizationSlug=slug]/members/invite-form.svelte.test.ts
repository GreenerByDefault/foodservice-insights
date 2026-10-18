import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { expectFetched, jsonResponse, stubFetch, stubPendingFetch } from '#lib/testing/fetch.js';
import { resetToastMocks, toast } from '#lib/testing/toast.js';
import InviteForm from './invite-form.svelte';

const invalidate = vi.fn();
const onInvited = vi.fn();
vi.mock('$app/navigation', () => ({ invalidate: (key: string) => invalidate(key) }));
vi.mock('svelte-sonner', () => import('#lib/testing/toast.js'));

afterEach(() => {
  vi.unstubAllGlobals();
  invalidate.mockClear();
  onInvited.mockClear();
  resetToastMocks();
});

async function filledOut(email = 'invitee@example.test') {
  const screen = await render(InviteForm, { organizationSlug: 'org-1', onInvited });
  await screen.getByLabelText('Email address').fill(email);
  return screen;
}

describe('InviteForm', () => {
  test('submits the email and the default Member role', async () => {
    const fetchMock = stubFetch(jsonResponse({ inviteId: 'invite-1', emailSent: true }, 201));
    const screen = await filledOut();

    await screen.getByRole('button', { name: 'Send invitation' }).click();

    await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
    expectFetched(fetchMock, {
      url: '/api/orgs/org-1/invites',
      method: 'POST',
      body: { email: 'invitee@example.test', role: 'member' },
    });
  });

  test('submits Admin once chosen', async () => {
    const fetchMock = stubFetch(jsonResponse({ inviteId: 'invite-1', emailSent: true }, 201));
    const screen = await filledOut();

    await screen
      .getByRole('radiogroup', { name: 'Role' })
      .getByRole('radio', { name: 'Admin' })
      .click();
    await screen.getByRole('button', { name: 'Send invitation' }).click();

    await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
    expectFetched(fetchMock, {
      url: '/api/orgs/org-1/invites',
      method: 'POST',
      body: { email: 'invitee@example.test', role: 'admin' },
    });
  });

  test('the button disables while submitting', async () => {
    const pending = stubPendingFetch();
    const screen = await filledOut();

    await screen.getByRole('button', { name: 'Send invitation' }).click();

    await expect.element(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();

    pending.resolve(jsonResponse({ inviteId: 'invite-1', emailSent: true }, 201));
    // Settled before the test ends, so its toast can't land in the next test.
    await expect.element(screen.getByRole('button', { name: 'Send invitation' })).toBeEnabled();
    await expect.poll(() => toast.success.mock.calls.length).toBe(1);
  });

  test('each role is described', async () => {
    const screen = await render(InviteForm, { organizationSlug: 'org-1', onInvited });
    const roles = screen.getByRole('radiogroup', { name: 'Role' });

    await expect
      .element(roles.getByRole('radio', { name: 'Member' }))
      .toHaveAccessibleDescription('Can see and upload reports.');
    await expect
      .element(roles.getByRole('radio', { name: 'Admin' }))
      .toHaveAccessibleDescription(
        'Can also invite and remove people, and manage the organization.',
      );
  });

  test('success calls onInvited, refreshes the list and toasts the address', async () => {
    stubFetch(jsonResponse({ inviteId: 'invite-1', emailSent: true }, 201));
    const screen = await filledOut();

    await screen.getByRole('button', { name: 'Send invitation' }).click();

    await expect.poll(() => toast.success.mock.calls).toEqual([['Invited invitee@example.test']]);
    expect(onInvited).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith('app:members');
  });

  test('a 409 shows an inline "already a member" error on the field and keeps the typed email', async () => {
    stubFetch(jsonResponse({ message: 'Already a member', code: 'already-member' }, 409));
    const screen = await filledOut();

    await screen.getByRole('button', { name: 'Send invitation' }).click();

    const emailInput = screen.getByLabelText('Email address');
    await expect.element(screen.getByText('That person is already a member.')).toBeVisible();
    await expect.element(emailInput).toHaveValue('invitee@example.test');
    await expect
      .element(emailInput)
      .toHaveAccessibleDescription('That person is already a member.');
    await expect.element(emailInput).toHaveAttribute('aria-invalid', 'true');
    expect(onInvited).not.toHaveBeenCalled();
  });

  test('a 429 shows the rate-limit alert', async () => {
    stubFetch(jsonResponse({ message: 'Too many invites', code: 'rate-limited' }, 429));
    const screen = await filledOut();

    await screen.getByRole('button', { name: 'Send invitation' }).click();

    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent("You've sent too many invites. Try again in an hour.");
    expect(onInvited).not.toHaveBeenCalled();
  });

  test('an invite sent but not emailed shows the warning and keeps the email to resend', async () => {
    stubFetch(jsonResponse({ inviteId: 'invite-1', emailSent: false }, 201));
    const screen = await filledOut();

    await screen.getByRole('button', { name: 'Send invitation' }).click();

    await expect
      .element(screen.getByRole('status'))
      .toHaveTextContent(/They're invited, but we couldn't email them/);
    await expect
      .element(screen.getByLabelText('Email address'))
      .toHaveValue('invitee@example.test');
    await expect.poll(() => invalidate.mock.calls).toEqual([['app:members']]);
    expect(onInvited).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  test('an unknown failure keeps the typed email, says to check Pending invitations, and refreshes them', async () => {
    stubFetch(jsonResponse({ message: 'Nope' }, 500));
    const screen = await filledOut();

    await screen.getByRole('button', { name: 'Send invitation' }).click();

    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent(
        "We couldn't tell whether that invite was sent. Close this and check Pending invitations. If it's not there, try again.",
      );
    await expect
      .element(screen.getByLabelText('Email address'))
      .toHaveValue('invitee@example.test');
    await expect.poll(() => invalidate.mock.calls.length).toBe(1);
    expect(invalidate).toHaveBeenCalledWith('app:members');
    expect(onInvited).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
