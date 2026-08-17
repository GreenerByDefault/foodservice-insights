/** The emailer, configured from the environment.
 *
 * **Not for the web app**, which uses Vite to load env vars. This entry point is for everything
 * else.
 *
 * There is no `shutdown()` here, unlike `@gbd/db/env` and `@gbd/storage/env`: a transport is
 * `fetch` and holds no pool of its own, so a script that imports this needs no cleanup to exit.
 */

import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import { type Emailer, initializeEmailer } from './client.ts';
import { resolveTransport } from './transports/index.ts';

loadLocalEnv();

export const EMAILER: Emailer = initializeEmailer({
  transport: resolveTransport({
    name: requireEnv('EMAIL_TRANSPORT'),
    endpoint: process.env.EMAIL_ENDPOINT,
  }),
  from: requireEnv('EMAIL_FROM'),
  siteUrl: requireEnv('SITE_URL'),
  gbdAddress: requireEnv('EMAIL_GBD_ADDRESS'),
  supportAddress: requireEnv('EMAIL_SUPPORT_ADDRESS'),
});
