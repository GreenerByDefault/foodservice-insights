import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ErrorPage from './error-page.svelte';

describe('ErrorPage', () => {
  it('leads with copy for the status rather than the status code', async () => {
    const screen = await render(ErrorPage, { status: 404 });

    await expect
      .element(screen.getByRole('heading', { level: 1 }))
      .toHaveTextContent('Page not found');
    expect(screen.getByText(/Error 404/).elements()).toHaveLength(0);
  });

  it('shows the status code on a failure the copy cannot explain, so a user can quote it', async () => {
    const screen = await render(ErrorPage, { status: 500 });

    await expect.element(screen.getByText('Error 500')).toBeInTheDocument();
  });
});
