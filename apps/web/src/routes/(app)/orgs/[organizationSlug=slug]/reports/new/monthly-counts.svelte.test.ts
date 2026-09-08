import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { CountDraft } from '$lib/reports/monthly-counts';
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
  });

  test('shows a year heading only once the months span more than one year', async () => {
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
    await expect.element(twoYears.getByRole('heading', { name: '2025' })).toBeInTheDocument();
    await expect.element(twoYears.getByRole('heading', { name: '2026' })).toBeInTheDocument();
  });

  test('legend follows the counts basis', async () => {
    const peopleCounts: CountDraft = $state({});
    const people = await render(MonthlyCounts, {
      months: ['2026-01'],
      basis: 'people',
      counts: peopleCounts,
    });
    await expect.element(people.getByText('Diners per month')).toBeInTheDocument();

    const mealsCounts: CountDraft = $state({});
    const meals = await render(MonthlyCounts, {
      months: ['2026-01'],
      basis: 'meals',
      counts: mealsCounts,
    });
    await expect.element(meals.getByText('Meals per month')).toBeInTheDocument();
  });

  test('the progress line counts down as the user fills in an input', async () => {
    const counts: CountDraft = $state({ '2026-01': 100 });
    const screen = await render(MonthlyCounts, {
      months: ['2026-01', '2026-02', '2026-03'],
      basis: 'people',
      counts,
    });

    await expect.element(screen.getByText('2 of 3 months still need a count')).toBeInTheDocument();

    await screen.getByRole('spinbutton', { name: 'February 2026' }).fill('200');
    await expect.element(screen.getByText('1 of 3 months still need a count')).toBeInTheDocument();
    expect(counts['2026-02']).toBe(200);
  });
});
