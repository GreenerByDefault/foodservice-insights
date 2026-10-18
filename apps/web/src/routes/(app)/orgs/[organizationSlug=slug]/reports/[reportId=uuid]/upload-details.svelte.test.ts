import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { ReportCounts } from './+page.server.ts';
import UploadDetails from './upload-details.svelte';

const INPUT_FILE = {
  href: '/file/input/00000000-0000-0000-0000-000000000000',
  originalFilename: 'orders.csv',
};
const NEW_REPORT_HREF = '/orgs/org-1/reports/new';

const MONTHLY = [
  { month: '2026-01', count: 4250 },
  { month: '2026-02', count: 135 },
];

function renderDetails(overrides: { unitSystem?: 'lb' | 'kg'; counts?: ReportCounts | null }) {
  return render(UploadDetails, {
    inputFile: INPUT_FILE,
    unitSystem: overrides.unitSystem ?? 'lb',
    counts:
      overrides.counts === undefined ? { basis: 'people', monthly: MONTHLY } : overrides.counts,
    newReportHref: NEW_REPORT_HREF,
  });
}

describe('UploadDetails', () => {
  test('links to the uploaded file', async () => {
    const screen = await renderDetails({});

    await expect
      .element(screen.getByRole('link', { name: INPUT_FILE.originalFilename }))
      .toHaveAttribute('href', INPUT_FILE.href);
  });

  test.each([
    ['lb', 'lb (pounds)'],
    ['kg', 'kg (kilograms)'],
  ] as const)('names the %s weight unit', async (unitSystem, expected) => {
    const screen = await renderDetails({ unitSystem });

    await expect.element(screen.getByText(expected)).toBeVisible();
  });

  test.each([
    ['people', 'Diners per month'],
    ['meals', 'Meals per month'],
  ] as const)('labels %s counts as the upload form did', async (countsBasis, expected) => {
    const screen = await renderDetails({ counts: { basis: countsBasis, monthly: MONTHLY } });

    await expect.element(screen.getByText(expected)).toBeVisible();
  });

  test('lists each month with its count', async () => {
    const screen = await renderDetails({});

    await expect.element(screen.getByText('January 2026')).toBeVisible();
    await expect.element(screen.getByText('4,250')).toBeVisible();
    await expect.element(screen.getByText('February 2026')).toBeVisible();
    await expect.element(screen.getByText('135')).toBeVisible();
  });

  test('says the counts were not provided when the upload had none', async () => {
    const screen = await renderDetails({ counts: null });

    await expect.element(screen.getByText('Diners or meals served')).toBeVisible();
    await expect.element(screen.getByText('Not provided')).toBeVisible();
    await expect.element(screen.getByText('January 2026')).not.toBeInTheDocument();
  });

  test('points to a new upload for fixing a mistake', async () => {
    const screen = await renderDetails({});

    await expect
      .element(screen.getByRole('link', { name: 'Upload your file again' }))
      .toHaveAttribute('href', NEW_REPORT_HREF);
  });
});
