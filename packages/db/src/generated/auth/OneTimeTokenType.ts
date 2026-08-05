/** Represents the enum auth.one_time_token_type */
type OneTimeTokenType =
  | 'confirmation_token'
  | 'reauthentication_token'
  | 'recovery_token'
  | 'email_change_token_new'
  | 'email_change_token_current'
  | 'phone_change_token';

export type { OneTimeTokenType as default };
