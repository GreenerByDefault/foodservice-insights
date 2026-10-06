import { afterEach, describe, expect, test } from 'vitest';
import { focusPageHeading } from './focus-page-heading.ts';

afterEach(() => {
  document.body.replaceChildren();
});

describe('focusPageHeading', () => {
  test('moves focus to a focusable h1', async () => {
    document.body.innerHTML = '<h1 tabindex="-1">Members</h1>';

    await focusPageHeading();

    expect(document.activeElement).toBe(document.querySelector('h1'));
  });

  test('does nothing on a page without an h1', async () => {
    await focusPageHeading();

    expect(document.activeElement).toBe(document.body);
  });
});
