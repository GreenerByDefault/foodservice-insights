/** Represents the enum public.rejected_upload_reason */
type RejectedUploadReason =
  | 'invalid_metadata'
  | 'too_large'
  | 'bad_columns'
  | 'unparseable'
  | 'empty'
  | 'bad_rows'
  | 'other';

export type { RejectedUploadReason as default };
