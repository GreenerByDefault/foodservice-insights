import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { CountDraft } from '#lib/reports/monthly-counts.js';
import MonthlyCounts from './monthly-counts.svelte';

describe('MonthlyCounts', () => {
  test('renders a labelled, required row for every month', async () => {
    const counts: CountDraft = $state({});
    const screen = await render(MonthlyCounts, {
      months: ['2026-01', '2026-02'],
      basis: 'people',
      counts,
    });

    const january = screen.getByRole('spinbutton', { name: 'January 2026' });
    const february = screen.getByRole('spinbutton', { name: 'February 2026' });
    await expect.element(january).toBeInTheDocument();
    await expect.element(february).toBeInTheDocument();
    await expect.element(january).toHaveAttribute('required');
    await expect.element(february).toHaveAttribute('required');
    await expect.element(january).toHaveAttribute('min', '1');
    await expect.element(february).toHaveAttribute('min', '1');
  });

  test('shows a second-level year heading only once the months span more than one year', async () => {
    const withinOneYear: CountDraft = $state({});
    const singleYear = await render(MonthlyCounts, {
      months: ['2026-01', '2026-02'],
      basis: 'people',
      counts: withinOneYear,
    });
    await expect.element(singleYear.getByRole('heading', { name: '2026' })).not.toBeInTheDocument();

    const acrossYears: CountDraft = $state({});
    const twoYears = await render(MonthlyCounts, {
      months: ['2025-12', '2026-01'],
      basis: 'people',
      counts: acrossYears,
    });
    await expect
      .element(twoYears.getByRole('heading', { name: '2025', level: 2 }))
      .toBeInTheDocument();
    await expect
      .element(twoYears.getByRole('heading', { name: '2026', level: 2 }))
      .toBeInTheDocument();
  });

  test.for([
    ['people', 'Diners per month', 'diners'],
    ['meals', 'Meals per month', 'meals'],
  ] as const)(
    'names the %s basis in the legend and the description',
    async ([basis, legend, counted]) => {
      const counts: CountDraft = $state({});
      const screen = await render(MonthlyCounts, { months: ['2026-01'], basis, counts });

      await expect
        .element(screen.getByRole('group', { name: legend }))
        .toHaveAccessibleDescription(
          `Use counts for the same sites as your file. For example, if your file only covers one dining hall, count only that dining hall's ${counted}, not the whole university's.`,
        );
    },
  );

  test('before a file is chosen, holds a placeholder where the months will go', async () => {
    const counts: CountDraft = $state({});
    const screen = await render(MonthlyCounts, { months: undefined, basis: 'people', counts });

    await expect
      .element(
        screen.getByText(
          'Choose a file above. Then you can enter a count here for each month it covers.',
        ),
      )
      .toBeInTheDocument();
    await expect.element(screen.getByRole('spinbutton')).not.toBeInTheDocument();
  });

  describe('the progress line', () => {
    test('counts up as the user fills in an input', async () => {
      const counts: CountDraft = $state({ '2026-01': 100 });
      const screen = await render(MonthlyCounts, {
        months: ['2026-01', '2026-02', '2026-03'],
        basis: 'people',
        counts,
      });

      await expect.element(screen.getByText('1 of 3 months filled in')).toBeInTheDocument();

      await screen.getByRole('spinbutton', { name: 'February 2026' }).fill('200');
      await expect.element(screen.getByText('2 of 3 months filled in')).toBeInTheDocument();
      expect(counts['2026-02']).toBe(200);
    });

    test('is left out for a single month', async () => {
      const counts: CountDraft = $state({});
      const screen = await render(MonthlyCounts, { months: ['2026-01'], basis: 'people', counts });

      await expect.element(screen.getByText('filled in', { exact: false })).not.toBeInTheDocument();
    });
  });
});
