/** A file refused before a row was read: the decode / layout / header / parse-error rejections.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { MAX_COLUMNS, MAX_DATA_ROWS } from '../../limits.ts';
import type { RejectedUploadRecord } from '../../rejection.ts';
import type {
  CsvParseError,
  DecodeFault,
  HeaderCandidate,
  HeaderFault,
  LayoutFault,
  RequiredColumn,
} from '../read/index.ts';
import { groupDigits, listOf } from './text.ts';

/** Every way `normalize.ts` can refuse a file before a single row of it is read. */
export type UnreadableFile =
  | { kind: 'decode'; fault: DecodeFault }
  | { kind: 'layout'; fault: LayoutFault }
  | { kind: 'parse'; error: CsvParseError }
  | { kind: 'no-data-rows' }
  | { kind: 'too-many-rows' };

export function describeUnreadableFile(file: UnreadableFile): RejectedUploadRecord {
  switch (file.kind) {
    case 'decode':
      return decodeRejection(file.fault);
    case 'layout':
      return layoutRejection(file.fault);
    case 'parse':
      return csvParseErrorRejection(file.error);
    case 'no-data-rows':
      return { reason: 'empty', summary: 'That file has a header but no rows under it.' };
    case 'too-many-rows':
      return {
        reason: 'too_large',
        summary: `That file has more than ${groupDigits(MAX_DATA_ROWS)} rows.`,
      };
  }
}

function decodeRejection(fault: DecodeFault): RejectedUploadRecord {
  switch (fault.kind) {
    case 'signature': {
      const name = fault.format === 'xlsx' ? 'an Excel (.xlsx) file' : 'an old Excel (.xls) file';
      return {
        reason: 'unparseable',
        summary: `That looks like ${name}, not a CSV. Save it as CSV and upload it again.`,
        rejectionDetail: `signature matched ${fault.format}`,
      };
    }
    case 'control-character':
      return {
        reason: 'unparseable',
        summary:
          'That file does not look like text. Save it as CSV (comma separated values) and upload it again.',
        rejectionDetail: `control character 0x${fault.code.toString(16)} at offset ${fault.offset}`,
      };
    case 'empty':
      return { reason: 'empty', summary: 'That file has no rows in it.' };
  }
}

function layoutRejection(fault: LayoutFault): RejectedUploadRecord {
  switch (fault.kind) {
    case 'parse-error':
      return csvParseErrorRejection(fault.error);
    case 'ambiguous':
      return {
        reason: 'bad_columns',
        summary:
          "We can't tell what separates your columns — this file could be split into columns more than one way. Save it as CSV (comma separated values) and upload it again.",
        rejectionDetail: describeAmbiguousDelimiters(fault.candidates),
      };
    case 'empty':
      return { reason: 'empty', summary: 'That file has no rows in it.' };
    case 'bad-header':
      return {
        reason: 'bad_columns',
        summary: fault.fault ? describeHeaderFault(fault.fault) : 'We could not read that file.',
        rejectionDetail: `header: ${fault.fields.slice(0, 20).join(' | ')}`,
      };
  }
}

function describeAmbiguousDelimiters(candidates: readonly HeaderCandidate[]): string {
  return candidates
    .map(({ delimiter, line }) => `${JSON.stringify(delimiter)} at line ${line}`)
    .join(' and ');
}

function describeHeaderFault(fault: HeaderFault): string {
  if (fault.kind === 'missing') {
    return `Your file needs a column for ${listOf(fault.columns.map(headerLabel))}.`;
  }
  return `Two columns could be the ${headerLabel(fault.column)}: ${listOf(
    fault.headers.map((header) => `"${header}"`),
  )}. Remove or rename one.`;
}

/** Deliberately a different label set from the row-problem wording in `rows.ts`: a header
 * sentence says "date ordered" — naming the column as the alias table spells it — while a row
 * sentence says "the date" — naming the value inside it.
 */
function headerLabel(column: RequiredColumn): string {
  return { product: 'product name', date: 'date ordered', weight: 'weight' }[column];
}

function csvParseErrorRejection(error: CsvParseError): RejectedUploadRecord {
  const rejectionDetail = `${error.failure} at line ${error.line}`;
  switch (error.failure) {
    case 'unclosed-quote':
      return {
        reason: 'unparseable',
        summary: `The quotes starting on line ${error.line} are never closed, so we cannot tell where that row ends.`,
        rejectionDetail,
      };
    case 'text-after-quote':
      return {
        reason: 'unparseable',
        summary: `Line ${error.line} has text after a closing quote. A quoted value has to fill the whole cell.`,
        rejectionDetail,
      };
    // "More than", because the parser stopped at the cap: the real width was never measured, and
    // measuring it is the cost this whole path exists to avoid.
    case 'too-many-columns':
      return {
        reason: 'too_large',
        summary: `That file has more than ${MAX_COLUMNS} columns, far past what we can read.`,
        rejectionDetail,
      };
  }
}
