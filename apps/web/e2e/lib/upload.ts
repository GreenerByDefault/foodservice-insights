import { XLSX_CONTENT_TYPE } from '@gbd/core';
import type { Page } from '@playwright/test';

const FILE_LABEL = 'Choose a CSV or Excel file';

/** Put a CSV into the new-report form's file input, as a real pick would. */
export async function chooseCsv(page: Page, filename: string, csv: string): Promise<void> {
  await page.getByLabel(FILE_LABEL, { exact: false }).setInputFiles({
    name: filename,
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
}

/** The same, for a workbook — the browser converts it before anything is sent. */
export async function chooseWorkbook(
  page: Page,
  filename: string,
  bytes: Uint8Array,
): Promise<void> {
  await page.getByLabel(FILE_LABEL, { exact: false }).setInputFiles({
    name: filename,
    mimeType: XLSX_CONTENT_TYPE,
    buffer: Buffer.from(bytes),
  });
}
