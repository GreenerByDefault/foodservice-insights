import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import UploadDetails from './upload-details.svelte';

const INPUT_FILE = {
  href: '/file/input/00000000-0000-0000-0000-000000000000',
  originalFilename: 'orders.csv',
};
const NEW_REPORT_HREF = '/orgs/org-1/reports/new';

function renderDetails(overrides: { unitSystem?: 'lb' | 'kg'; countsBasis?: 'people' | 'meals' }) {
  return render(UploadDetails, {
    inputFile: INPUT_FILE,
    unitSystem: overrides.unitSystem ?? 'lb',
    countsBasis: overrides.countsBasis ?? 'people',
    monthlyCounts: [
      { month: '2026-01', count: 4250 },
      { month: '2026-02', count: 135 },
    ],
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
    const screen = await renderDetails({ countsBasis });

    await expect.element(screen.getByText(expected)).toBeVisible();
  });

  test('lists each month with its count', async () => {
    const screen = await renderDetails({});

    await expect.element(screen.getByText('January 2026')).toBeVisible();
    await expect.element(screen.getByText('4,250')).toBeVisible();
    await expect.element(screen.getByText('February 2026')).toBeVisible();
    await expect.element(screen.getByText('135')).toBeVisible();
  });

  test('points to a new upload for fixing a mistake', async () => {
    const screen = await renderDetails({});

    await expect
      .element(screen.getByRole('link', { name: 'Upload your file again' }))
      .toHaveAttribute('href', NEW_REPORT_HREF);
  });
});
