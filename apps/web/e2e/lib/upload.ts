import type { Page } from '@playwright/test';

/** Put a CSV into the new-report form's file input, as a real pick would. */
export async function chooseCsv(page: Page, filename: string, csv: string): Promise<void> {
  await page.getByLabel('Choose a CSV file', { exact: false }).setInputFiles({
    name: filename,
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
}
