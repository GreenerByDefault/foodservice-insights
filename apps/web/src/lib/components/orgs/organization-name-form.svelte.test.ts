import { createRawSnippet } from 'svelte';
import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import OrganizationNameForm from './organization-name-form.svelte';

const unknownNotice = createRawSnippet(() => ({
  render: () => '<span>Something went wrong.</span>',
}));

function props(
  onSubmit: (
    name: string,
  ) => Promise<
    'done' | 'name-taken' | 'slug-taken' | 'slug-reserved' | 'slug-underivable' | 'unknown'
  >,
) {
  return {
    initialName: 'Acme Foodservice',
    submitLabel: 'Save',
    submittingLabel: 'Saving…',
    unknownNotice,
    onSubmit,
  };
}

describe('OrganizationNameForm', () => {
  test('is seeded with the current name', async () => {
    const screen = await render(OrganizationNameForm, props(vi.fn()));

    await expect
      .element(screen.getByLabelText('Organization name'))
      .toHaveValue('Acme Foodservice');
  });

  test('an unrelated re-render — e.g. a background invalidateAll() — does not clobber an in-progress edit', async () => {
    const screen = await render(OrganizationNameForm, props(vi.fn()));
    const input = screen.getByLabelText('Organization name');

    await input.fill('Unsaved Draft');
    // The parent re-rendering with the same `initialName` it already had — not a save, and not a
    // real rename — is what a reassigned prop would have silently reverted to. See the comment on
    // `let name = $state(initialName)` in organization-name-form.svelte.
    await screen.rerender({ ...props(vi.fn()), initialName: 'Acme Foodservice' });

    await expect.element(input).toHaveValue('Unsaved Draft');
  });

  test('submits the trimmed name', async () => {
    const onSubmit = vi.fn().mockResolvedValue('done');
    const screen = await render(OrganizationNameForm, props(onSubmit));

    await screen.getByLabelText('Organization name').fill('  Riverside Foods  ');
    await screen.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => onSubmit.mock.calls.length).toBe(1);
    expect(onSubmit).toHaveBeenCalledWith('Riverside Foods');
  });

  test('a "done" outcome returns the button to idle', async () => {
    const onSubmit = vi.fn().mockResolvedValue('done');
    const screen = await render(OrganizationNameForm, props(onSubmit));

    await screen.getByRole('button', { name: 'Save' }).click();

    await expect.element(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  test('a "name-taken" outcome shows the inline error, moves focus, and keeps the typed name', async () => {
    const onSubmit = vi.fn().mockResolvedValue('name-taken');
    const screen = await render(OrganizationNameForm, props(onSubmit));

    await screen.getByLabelText('Organization name').fill('Riverside Foods');
    await screen.getByRole('button', { name: 'Save' }).click();

    await expect
      .element(screen.getByText('An organization with that name already exists.'))
      .toBeInTheDocument();
    await expect.element(screen.getByLabelText('Organization name')).toHaveValue('Riverside Foods');
    await expect.element(screen.getByLabelText('Organization name')).toHaveFocus();
  });

  test.for([
    [
      'slug-taken',
      "That name is too close to another organization's. Try adding your region or division.",
    ],
    ['slug-reserved', "That name isn't available. Try adding your region or division."],
    ['slug-underivable', 'That name needs at least one letter or number in a–z or 0–9.'],
  ] as const)(
    'a "%s" outcome shows its inline error and moves focus',
    async ([outcome, message]) => {
      const onSubmit = vi.fn().mockResolvedValue(outcome);
      const screen = await render(OrganizationNameForm, props(onSubmit));

      await screen.getByLabelText('Organization name').fill('Riverside Foods');
      await screen.getByRole('button', { name: 'Save' }).click();

      await expect.element(screen.getByText(message)).toBeInTheDocument();
      await expect.element(screen.getByLabelText('Organization name')).toHaveFocus();
    },
  );

  test('an "unknown" outcome renders the caller-supplied notice as an alert', async () => {
    const onSubmit = vi.fn().mockResolvedValue('unknown');
    const screen = await render(OrganizationNameForm, props(onSubmit));

    await screen.getByRole('button', { name: 'Save' }).click();

    await expect.element(screen.getByRole('alert')).toHaveTextContent('Something went wrong.');
  });

  test('the button disables and swaps its label while the request is in flight', async () => {
    let resolveSubmit!: (outcome: 'done') => void;
    const onSubmit = vi.fn().mockReturnValue(new Promise((resolve) => (resolveSubmit = resolve)));
    const screen = await render(OrganizationNameForm, props(onSubmit));

    await screen.getByRole('button', { name: 'Save' }).click();

    await expect.element(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    resolveSubmit('done');
  });

  test('a legend renders a fieldset with a visually hidden field label', async () => {
    const screen = await render(OrganizationNameForm, {
      ...props(vi.fn()),
      legend: 'Rename organization',
    });

    await expect
      .element(screen.getByRole('group', { name: 'Rename organization' }))
      .toBeInTheDocument();
  });
});
