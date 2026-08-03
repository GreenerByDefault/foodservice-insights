import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import AppTitle from './app-title.svelte';

describe('AppTitle', () => {
  it('placeholder component test: renders the product name as the page heading', async () => {
    const screen = await render(AppTitle);

    await expect
      .element(screen.getByRole('heading', { level: 1 }))
      .toHaveTextContent('Foodservice Insights');
  });
});
