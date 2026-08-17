/** The emailer, configured from the environment.
 *
 * **Not for the web app**, which uses Vite to load env vars. This entry point is for everything
 * else.
 *
 * There is no `shutdown()` here, unlike `@gbd/db/env` and `@gbd/storage/env`: a transport is
 * `fetch` and holds no pool of its own, so a script that imports this needs no cleanup to exit.
 */

import { APP_NAME } from '@gbd/core';
import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import { type Emailer, initializeEmailer } from './client.ts';
import { parseTransportSettings, resolveTransport } from './transports/index.ts';

loadLocalEnv();

export const EMAILER: Emailer = initializeEmailer({
  transport: resolveTransport(
    parseTransportSettings({
      name: requireEnv('EMAIL_TRANSPORT'),
      endpoint: process.env.EMAIL_ENDPOINT,
    }),
  ),
  from: { address: requireEnv('EMAIL_FROM_ADDRESS'), name: APP_NAME },
  siteUrl: requireEnv('SITE_URL'),
  gbdAddress: requireEnv('EMAIL_GBD_ADDRESS'),
  supportAddress: requireEnv('EMAIL_SUPPORT_ADDRESS'),
});
