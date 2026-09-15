import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { expectFetched, jsonResponse, stubFetch, stubPendingFetch } from '$lib/testing/fetch';
import InviteForm from './invite-form.svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
});

async function filledOut(email = 'invitee@example.test') {
  const screen = await render(InviteForm, { organizationSlug: 'org-1' });
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

    await screen.getByRole('radio', { name: 'Admin' }).click();
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
  });

  test('success clears the field', async () => {
    stubFetch(jsonResponse({ inviteId: 'invite-1', emailSent: true }, 201));
    const screen = await filledOut();

    await screen.getByRole('button', { name: 'Send invitation' }).click();

    await expect.element(screen.getByLabelText('Email address')).toHaveValue('');
  });

  test('a 409 shows an inline "already a member" error and keeps the typed email', async () => {
    stubFetch(jsonResponse({ message: 'Already a member', code: 'already-member' }, 409));
    const screen = await filledOut();

    await screen.getByRole('button', { name: 'Send invitation' }).click();

    await expect.element(screen.getByText('That person is already a member.')).toBeVisible();
    await expect
      .element(screen.getByLabelText('Email address'))
      .toHaveValue('invitee@example.test');
  });

  test('a 429 shows the rate-limit alert', async () => {
    stubFetch(jsonResponse({ message: 'Too many invites', code: 'rate-limited' }, 429));
    const screen = await filledOut();

    await screen.getByRole('button', { name: 'Send invitation' }).click();

    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent("You've sent too many invites. Try again in an hour.");
  });

  test('an invite sent but not emailed shows the warning, and still clears the field', async () => {
    stubFetch(jsonResponse({ inviteId: 'invite-1', emailSent: false }, 201));
    const screen = await filledOut();

    await screen.getByRole('button', { name: 'Send invitation' }).click();

    await expect
      .element(screen.getByText("Saved, but the email couldn't be sent — try inviting them again."))
      .toBeVisible();
    await expect.element(screen.getByLabelText('Email address')).toHaveValue('');
  });

  test('an unknown failure keeps the typed email and warns to check the list', async () => {
    stubFetch(jsonResponse({ message: 'Nope' }, 500));
    const screen = await filledOut();

    await screen.getByRole('button', { name: 'Send invitation' }).click();

    await expect
      .element(screen.getByText(/We're not sure whether that invite went through/))
      .toBeVisible();
    await expect
      .element(screen.getByLabelText('Email address'))
      .toHaveValue('invitee@example.test');
  });
});
