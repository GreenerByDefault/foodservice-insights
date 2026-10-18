import { afterEach, describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { jsonResponse, stubFetch, stubPendingFetch } from '#lib/testing/fetch.js';
import { resetToastMocks, toast } from '#lib/testing/toast.js';
import InviteDialog from './invite-dialog.svelte';

vi.mock('$app/navigation', () => ({ invalidate: vi.fn() }));
vi.mock('svelte-sonner', () => import('#lib/testing/toast.js'));

afterEach(() => {
  vi.unstubAllGlobals();
  resetToastMocks();
});

const TITLE = 'Invite someone to Acme Foodservice';

async function opened() {
  const screen = await render(InviteDialog, {
    organizationSlug: 'org-1',
    organizationName: 'Acme Foodservice',
  });
  await screen.getByRole('button', { name: 'Invite someone' }).click();
  await expect.element(screen.getByRole('dialog', { name: TITLE })).toBeVisible();
  return screen;
}

async function submit(screen: Awaited<ReturnType<typeof opened>>, email = 'a@example.test') {
  await screen.getByLabelText('Email address').fill(email);
  await screen.getByRole('button', { name: 'Send invitation' }).click();
}

describe('InviteDialog', () => {
  test('says how long the invitation lasts', async () => {
    const screen = await opened();

    await expect
      .element(screen.getByRole('dialog', { name: TITLE }))
      .toHaveAccessibleDescription(
        "We'll email them a link to join. The invitation lasts 14 days.",
      );
  });

  test('closes on success and returns focus to its trigger', async () => {
    stubFetch(jsonResponse({ inviteId: 'invite-1', emailSent: true }, 201));
    const screen = await opened();

    await submit(screen);

    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
    await expect.element(screen.getByRole('button', { name: 'Invite someone' })).toHaveFocus();
    await expect.poll(() => toast.success.mock.calls).toEqual([['Invited a@example.test']]);
  });

  test.each([
    {
      outcome: 'already a member',
      response: jsonResponse({ message: 'Already a member', code: 'already-member' }, 409),
      message: 'That person is already a member.',
    },
    {
      outcome: 'rate-limited',
      response: jsonResponse({ message: 'Too many invites', code: 'rate-limited' }, 429),
      message: "You've sent too many invites. Try again in an hour.",
    },
    {
      outcome: 'saved but not emailed',
      response: jsonResponse({ inviteId: 'invite-1', emailSent: false }, 201),
      message: "They're invited, but we couldn't email them. Send the invite again to retry.",
    },
    {
      outcome: 'unknown',
      response: jsonResponse({ message: 'Nope' }, 500),
      message: "We couldn't tell whether that invite was sent.",
    },
  ])('stays open to show the $outcome message', async ({ response, message }) => {
    stubFetch(response);
    const screen = await opened();

    await submit(screen);

    const dialog = screen.getByRole('dialog', { name: TITLE });
    await expect.element(dialog.getByText(message, { exact: false })).toBeVisible();
    await expect.element(dialog).toBeVisible();
  });

  test('reopens with an empty form after closing', async () => {
    stubFetch(jsonResponse({ message: 'Already a member', code: 'already-member' }, 409));
    const screen = await opened();
    await submit(screen);
    await expect.element(screen.getByText('That person is already a member.')).toBeVisible();

    await screen.getByRole('button', { name: 'Cancel' }).click();
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
    await screen.getByRole('button', { name: 'Invite someone' }).click();

    await expect.element(screen.getByLabelText('Email address')).toHaveValue('');
    await expect
      .element(screen.getByText('That person is already a member.'))
      .not.toBeInTheDocument();
  });

  test('Escape does not close it while the invite is sending', async () => {
    const pending = stubPendingFetch();
    const screen = await opened();
    await submit(screen);
    await expect.element(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    await expect.element(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await userEvent.keyboard('{Escape}');

    await expect.element(screen.getByRole('dialog', { name: TITLE })).toBeVisible();
    pending.resolve(jsonResponse({ message: 'Too many invites', code: 'rate-limited' }, 429));
    await expect
      .element(screen.getByText("You've sent too many invites. Try again in an hour."))
      .toBeVisible();
  });
});
