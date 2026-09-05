import type { Page } from '@playwright/test';

/** Put a CSV into the new-report form's file input, as a real pick would.
 *
 * The buffer never touches disk: Playwright accepts an in-memory payload for `setInputFiles`, so
 * a spec's CSV can stay a string constant next to the assertions about it.
 */
export async function chooseCsv(page: Page, filename: string, csv: string): Promise<void> {
  await page.getByLabel('Choose a CSV file', { exact: false }).setInputFiles({
    name: filename,
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
}
