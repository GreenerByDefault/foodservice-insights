import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ResultView from './result-view.svelte';

const NOW = new Date('2026-01-15T10:14:00Z');
const FINISHED_AT = new Date('2026-01-15T10:10:00Z');
const FILES = {
  pdf: { href: '/file/result/00000000-0000-0000-0000-000000000001' },
  xlsx: { href: '/file/result/00000000-0000-0000-0000-000000000002' },
};
const INPUT_FILE = {
  href: '/file/input/00000000-0000-0000-0000-000000000000',
  originalFilename: 'orders.csv',
  byteSize: 12_000,
};
const DELETE_ACTION = { href: '/api/orgs/org-1/reports/report-1', afterHref: '/orgs/org-1' };

describe('ResultView', () => {
  test('links to the pdf, the excel file, and the original file', async () => {
    const screen = await render(ResultView, {
      finishedAt: FINISHED_AT,
      now: NOW,
      files: FILES,
      inputFile: INPUT_FILE,
      deleteAction: DELETE_ACTION,
    });

    await expect
      .element(screen.getByRole('link', { name: 'Download PDF' }))
      .toHaveAttribute('href', FILES.pdf.href);
    await expect
      .element(screen.getByRole('link', { name: 'Download Excel' }))
      .toHaveAttribute('href', FILES.xlsx.href);
    await expect
      .element(screen.getByRole('link', { name: INPUT_FILE.originalFilename }))
      .toHaveAttribute('href', INPUT_FILE.href);
    await expect.element(screen.getByText('Uploaded file:')).toBeVisible();
  });
});
