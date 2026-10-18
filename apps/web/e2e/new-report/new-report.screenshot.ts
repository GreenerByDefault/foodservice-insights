import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';
import { chooseCsv } from '../lib/upload.ts';

// The switcher renders `org`'s name in every image below, so it is pinned rather than random.
// Pinning shares one organization across this file's tests, which is what keeps them parallel —
// see the `orgName` option.
test.use({ orgName: 'Cedar Lane Catering' });

test('the new report form, before any file is chosen', async ({ page, org }) => {
  await page.goto(`/orgs/${org.slug}/reports/new`);
  await ensureHydrated(page);

  await expect(page.getByText('Choose a CSV or Excel file')).toBeVisible();
  await expectScreenshots(page, 'no-file.png');
});

// Spans two years, so the shot also exercises the year headings, and more than six months, so the
// inputs fall into two columns at the wider widths.
const CSV = [
  'product,date,weight',
  ...['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'].map(
    (month) => `beef,${month}-05,12`,
  ),
].join('\n');

test('the new report form, asking for the weight unit, with the monthly counts partway filled in', async ({
  page,
  org,
}) => {
  await page.goto(`/orgs/${org.slug}/reports/new`);
  await ensureHydrated(page);

  await chooseCsv(page, 'procurement.csv', CSV);

  // Fills some months and leaves the rest untouched — a mid-progress state exercises the progress
  // line and the filled/empty input contrast that an all-empty or all-filled shot would miss.
  await page.getByRole('spinbutton', { name: 'November 2025' }).fill('120');
  await page.getByRole('spinbutton', { name: 'December 2025' }).fill('115');
  await page.getByRole('spinbutton', { name: 'January 2026' }).fill('130');

  await expect(page.getByText('3 of 8 months filled in')).toBeVisible();
  await expectScreenshots(page, 'unit-asked.png');
});

// The name is long enough to truncate on mobile, beside the line the header's unit adds.
const LONG_FILENAME = 'cedar-lane-catering-purchases-january-to-march-2026-all-sites.csv';

test('the new report form, with the weight unit taken from the header', async ({ page, org }) => {
  await page.goto(`/orgs/${org.slug}/reports/new`);
  await ensureHydrated(page);

  await chooseCsv(
    page,
    LONG_FILENAME,
    ['Product,Date,Weight (lb)', 'beef,2026-01-05,12'].join('\n'),
  );

  await expect(page.getByText('Weights are in pounds, as the column name says.')).toBeVisible();
  // The rest of the form is `unit-asked.png`'s.
  await expectScreenshots(page, 'unit-from-header.png', {
    clipBelow: page.getByRole('group', { name: 'Purchasing data' }),
  });
});

test('the new report form, with counts skipped', async ({ page, org }) => {
  await page.goto(`/orgs/${org.slug}/reports/new`);
  await ensureHydrated(page);

  // A header that names the unit keeps the weight question, which `unit-asked.png` covers, out of
  // the shot.
  await chooseCsv(
    page,
    'procurement.csv',
    ['Product,Date,Weight (lb)', 'beef,2026-01-05,12'].join('\n'),
  );
  await page.getByRole('radio', { name: 'Skip counts' }).click();

  await expect(
    page.getByText('Your report will show totals only.', { exact: false }),
  ).toBeVisible();
  await expectScreenshots(page, 'no-counts.png');
});

// Every column at once, one distinct fault per row plus two rows whose dates prove opposite
// orders, so the rejection view renders its worst realistic case: MAX_PROBLEMS_REPORTED row
// problems, a date-order problem above them, and the "Showing N of M" truncation note. The
// has-a-unit weight fault repeats on four rows — three contiguous, one apart — so the shot also
// exercises `formatRows`' range grouping ("4 rows: 2–4, 9") rather than only ever "row N". Every
// other row keeps its other two columns valid so it fails for exactly one reason.
const WORST_CASE_REJECTION_CSV = [
  'product,date,weight',
  'beef,2026-01-05,5 oz', // weight: has a unit (1 of 4 — contiguous run starts)
  'beef,2026-01-05,5 oz', // weight: has a unit (2 of 4)
  'beef,2026-01-05,5 oz', // weight: has a unit (3 of 4)
  ',2026-01-05,12', // product: empty
  'n/a,2026-01-05,12', // product: placeholder
  'be\tef,2026-01-05,12', // product: invisible character
  '=SUM,2026-01-05,12', // product: formula trigger
  'beef,2026-01-05,5 oz', // weight: has a unit (4 of 4 — after a gap)
  'beef,2026-01-05,', // weight: empty
  'beef,2026-01-05,(5)', // weight: parenthesized negative
  'beef,2026-01-05,-5', // weight: negative
  'beef,2026-01-05,$5', // weight: money
  'beef,2026-01-05,5e10', // weight: scientific
  'beef,2026-01-05,abc', // weight: not a number
  'beef,2026-01-05,"12,3"', // weight: comma decimal
  'beef,2026-01-05,.5', // weight: not plain
  'beef,2026-01-05,9999999999999999', // weight: too many digits
  'beef,,12', // date: empty
  'beef,frobtember 2026,12', // date: unknown month name
  'beef,45000,12', // date: date serial
  'beef,banana,12', // date: unrecognized
  'beef,2026-02-30,12', // date: not a real calendar date
  'beef,1999-12-31,12', // date: too old
  'beef,2099-12-31,12', // date: too far ahead
  'beef,13/02/2026,12', // date order: proves day-first
  'beef,02/13/2026,12', // date order: proves month-first
].join('\n');

test('the rejection view, with a file dense enough to trigger every kind of problem', async ({
  page,
  org,
}) => {
  await page.goto(`/orgs/${org.slug}/reports/new`);
  await ensureHydrated(page);

  await chooseCsv(page, 'worst-case.csv', WORST_CASE_REJECTION_CSV);

  await expect(page.getByText('Showing 20 of 22 things to fix.', { exact: false })).toBeVisible();
  await expect(page.getByText('4 rows: 2–4, 9', { exact: false })).toBeVisible();
  await expectScreenshots(page, 'rejection-every-kind.png');
});

// Every row has the same weight fault and nothing else wrong, so `everyRow` is true — the one
// case the worst-case fixture above can't reach, since there each row fails for exactly one of
// several distinct reasons instead of all rows failing for the same one.
const EVERY_ROW_REJECTION_CSV = [
  'product,date,weight',
  'beef,2026-01-05,5 oz',
  'beef,2026-01-06,5 oz',
  'beef,2026-01-07,5 oz',
].join('\n');

test('the rejection view, with a rule that fails on every row', async ({ page, org }) => {
  await page.goto(`/orgs/${org.slug}/reports/new`);
  await ensureHydrated(page);

  await chooseCsv(page, 'every-row.csv', EVERY_ROW_REJECTION_CSV);

  await expect(page.getByText('all 3 rows', { exact: false })).toBeVisible();
  await expectScreenshots(page, 'rejection-every-row.png');
});

// A missing column is a header fault, caught before any row is read — the rejection carries
// only a summary, no rowProblems and no dateOrderProblem. That's the sparsest shape the
// rejection view renders, and the one shot above it can't reach: no list, no date-order block,
// and only the bottom "Back to the form" button (see rejection-view.svelte's `hasScrollableDetail`
// check).
const MISSING_COLUMN_CSV = ['product,date', 'beef,2026-01-05'].join('\n');

test('the rejection view, with only a bare summary and no row list', async ({ page, org }) => {
  await page.goto(`/orgs/${org.slug}/reports/new`);
  await ensureHydrated(page);

  await chooseCsv(page, 'missing-column.csv', MISSING_COLUMN_CSV);

  await expect(page.getByText('Your file needs a column for weight.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to the form' })).toHaveCount(1);
  await expectScreenshots(page, 'rejection-bare-summary.png');
});
