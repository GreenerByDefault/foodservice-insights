/** Represents the enum public.rejected_upload_reason */
type RejectedUploadReason =
  | 'invalid_metadata'
  | 'too_large'
  | 'bad_columns'
  | 'unparseable'
  | 'csv_injection'
  | 'empty'
  | 'bad_rows'
  | 'other';

export type { RejectedUploadReason as default };
