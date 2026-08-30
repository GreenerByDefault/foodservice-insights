import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { AnalysisAttemptId } from './AnalysisAttempt.js';
import type { default as ResultFileKind } from './ResultFileKind.js';

/** Identifier type for public.result_file */
export type ResultFileId = string & { __brand: 'public.result_file' };

/** Represents the table public.result_file */
export default interface ResultFileTable {
  id: ColumnType<ResultFileId, ResultFileId | undefined, ResultFileId>;

  analysisAttemptId: ColumnType<AnalysisAttemptId, AnalysisAttemptId, AnalysisAttemptId>;

  kind: ColumnType<ResultFileKind, ResultFileKind, ResultFileKind>;

  storageKey: ColumnType<string, string, string>;

  byteSize: ColumnType<number, number, number>;

  contentType: ColumnType<string, string, string>;

  checksumSha256: ColumnType<unknown, unknown, unknown>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type ResultFile = Selectable<ResultFileTable>;

export type NewResultFile = Insertable<ResultFileTable>;

export type ResultFileUpdate = Updateable<ResultFileTable>;
