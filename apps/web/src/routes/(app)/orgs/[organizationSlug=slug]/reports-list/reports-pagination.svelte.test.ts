import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ReportsPagination from './reports-pagination.svelte';

describe('ReportsPagination', () => {
  test('renders nothing when there is no older or newer page', async () => {
    const screen = await render(ReportsPagination, { olderHref: null, newerHref: null });

    await expect.element(screen.getByRole('navigation')).not.toBeInTheDocument();
  });

  test('shows only Older on the newest page', async () => {
    const screen = await render(ReportsPagination, { olderHref: '?older=abc', newerHref: null });

    await expect
      .element(screen.getByRole('link', { name: 'Older' }))
      .toHaveAttribute('href', '?older=abc');
    await expect.element(screen.getByRole('link', { name: 'Newer' })).not.toBeInTheDocument();
  });

  test('shows only Newer on the oldest page', async () => {
    const screen = await render(ReportsPagination, { olderHref: null, newerHref: '?newer=abc' });

    await expect
      .element(screen.getByRole('link', { name: 'Newer' }))
      .toHaveAttribute('href', '?newer=abc');
    await expect.element(screen.getByRole('link', { name: 'Older' })).not.toBeInTheDocument();
  });

  test('shows both on a middle page', async () => {
    const screen = await render(ReportsPagination, {
      olderHref: '?older=abc',
      newerHref: '?newer=def',
    });

    await expect.element(screen.getByRole('link', { name: 'Older' })).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'Newer' })).toBeVisible();
  });
});
