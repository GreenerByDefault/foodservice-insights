import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { Finding } from './+page.server.ts';
import DataQualityNotice from './data-quality-notice.svelte';

const VOLATILE_MONTHS: Finding = {
  message: 'Found 2 months where the total pounds changed by more than 50% from the month before.',
  sampleValues: [
    'Feb 2026: 1,200 lb against 3,400 lb in Jan 2026 (-65%).',
    'Mar 2026: 3,300 lb against 1,200 lb in Feb 2026 (+175%).',
  ],
};
const NO_SAMPLES: Finding = {
  message: 'Found 1 missing internal month between Jan 2026 and Mar 2026: Feb 2026.',
  sampleValues: [],
};

describe('DataQualityNotice', () => {
  test('renders nothing when every check passed', async () => {
    const screen = await render(DataQualityNotice, { findings: [] });

    expect(screen.container.textContent?.trim()).toBe('');
  });

  test.each([
    { findings: [NO_SAMPLES], heading: 'This report has 1 data quality warning' },
    { findings: [VOLATILE_MONTHS, NO_SAMPLES], heading: 'This report has 2 data quality warnings' },
  ])('heads $findings.length finding(s) with "$heading"', async ({ findings, heading }) => {
    const screen = await render(DataQualityNotice, { findings });

    await expect.element(screen.getByRole('heading', { level: 2 })).toHaveTextContent(heading);
  });

  test('is a region named by its heading, not an alert, since the live headline already announces the result', async () => {
    const screen = await render(DataQualityNotice, { findings: [VOLATILE_MONTHS] });

    await expect
      .element(screen.getByRole('region', { name: 'This report has 1 data quality warning' }))
      .toBeVisible();
    expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  });

  test('shows every message, in order, with its examples collapsed until asked for', async () => {
    const screen = await render(DataQualityNotice, { findings: [VOLATILE_MONTHS, NO_SAMPLES] });

    const messages = screen.container.querySelectorAll('ul > li > p');
    expect([...messages].map((message) => message.textContent)).toEqual([
      VOLATILE_MONTHS.message,
      NO_SAMPLES.message,
    ]);
    const sample = screen.getByText(VOLATILE_MONTHS.sampleValues[0] ?? '');
    await expect.element(sample).not.toBeVisible();

    await screen.getByText('Examples (2)').click();

    await expect.element(sample).toBeVisible();
  });

  test('offers no examples for a finding that has none', async () => {
    const screen = await render(DataQualityNotice, { findings: [NO_SAMPLES] });

    await expect.element(screen.getByText(NO_SAMPLES.message)).toBeVisible();
    await expect.element(screen.getByText('Examples', { exact: false })).not.toBeInTheDocument();
  });
});
