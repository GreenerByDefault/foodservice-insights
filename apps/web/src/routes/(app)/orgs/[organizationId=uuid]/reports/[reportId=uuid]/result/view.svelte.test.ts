import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ResultView from './view.svelte';

const FINISHED_AT = new Date('2026-01-15T10:10:00Z');
const CHART = {
  href: '/file/result/00000000-0000-0000-0000-000000000003',
  chartKey: 'total_spend',
};
const FILES = {
  pdf: { href: '/file/result/00000000-0000-0000-0000-000000000001' },
  xlsx: { href: '/file/result/00000000-0000-0000-0000-000000000002' },
  charts: [CHART],
};
const INPUT_FILE = {
  href: '/file/input/00000000-0000-0000-0000-000000000000',
  originalFilename: 'orders.csv',
};

describe('ResultView', () => {
  test('links to the pdf, the excel file, each chart, and the original file', async () => {
    const screen = await render(ResultView, {
      finishedAt: FINISHED_AT,
      files: FILES,
      inputFile: INPUT_FILE,
    });

    await expect
      .element(screen.getByRole('link', { name: 'Download PDF' }))
      .toHaveAttribute('href', FILES.pdf.href);
    await expect
      .element(screen.getByRole('link', { name: 'Download Excel' }))
      .toHaveAttribute('href', FILES.xlsx.href);
    await expect
      .element(screen.getByRole('link', { name: CHART.chartKey }))
      .toHaveAttribute('href', CHART.href);
    await expect
      .element(screen.getByRole('link', { name: INPUT_FILE.originalFilename }))
      .toHaveAttribute('href', INPUT_FILE.href);
  });
});
