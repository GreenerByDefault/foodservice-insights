import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { ReportId } from './Report.js';

/** Identifier type for public.input_file */
export type InputFileId = string & { __brand: 'public.input_file' };

/** Represents the table public.input_file */
export default interface InputFileTable {
  id: ColumnType<InputFileId, InputFileId | undefined, InputFileId>;

  reportId: ColumnType<ReportId, ReportId, ReportId>;

  storageKey: ColumnType<string, string, string>;

  byteSize: ColumnType<number, number, number>;

  contentType: ColumnType<string, string, string>;

  originalFilename: ColumnType<string, string, string>;

  checksumSha256: ColumnType<unknown, unknown, unknown>;

  /** Whether storage_key holds bytes the user did not send. When true, the upload as received is at the same key suffixed -original, which no row references. When false, storage_key is it. */
  isModified: ColumnType<boolean, boolean, boolean>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type InputFile = Selectable<InputFileTable>;

export type NewInputFile = Insertable<InputFileTable>;

export type InputFileUpdate = Updateable<InputFileTable>;
