import type { default as AuthSchema } from './auth/AuthSchema.js';
import type { default as PublicSchema } from './public/PublicSchema.js';

type Database = PublicSchema & AuthSchema;

export type { Database as default };
