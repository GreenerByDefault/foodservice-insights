/** An Excel workbook into the CSV bytes `csv/` reads, judged only as a container. */

export type { ChosenSheet, WorkbookConversion, WorkbookFault } from './convert.ts';
export { convertWorkbook } from './convert.ts';
export {
  describeOversizeConversion,
  describeWorkbookFault,
  withSheetHint,
} from './describe.ts';
