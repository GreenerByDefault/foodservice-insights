import { defineEnvVars } from '@sveltejs/kit/env';
import * as v from 'valibot';

// Every variable is optional here, and dynamic (SvelteKit's default): one built image runs in any
// environment, and a missing value fails where it is read — `requirePrivateVar` and
// `requirePublicVar` in `#lib/server/env.ts`, with a pointer at the setup instructions — rather
// than stopping a process that never needed it.
const optional = { schema: v.optional(v.string()) };
const optionalPublic = { ...optional, public: true };

export const variables = defineEnvVars({
  DB_CONNECTION_STRING: optional,
  SITE_URL: optional,

  S3_ENDPOINT: optional,
  S3_REGION: optional,
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  S3_BUCKET: optional,

  EMAIL_TRANSPORT: optional,
  EMAIL_ENDPOINT: optional,
  EMAIL_FROM_ADDRESS: optional,
  EMAIL_GBD_ADDRESS: optional,
  EMAIL_SUPPORT_ADDRESS: optional,

  WORKER_MODE: optional,
  REPORT_RATE_LIMIT: optional,
  LOG_LEVEL: optional,
  LOG_FORMAT: optional,

  PUBLIC_AUTH_MODE: optionalPublic,
  PUBLIC_SUPABASE_URL: optionalPublic,
  PUBLIC_SUPABASE_PUBLISHABLE_KEY: optionalPublic,
});
