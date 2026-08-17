/** vitest `globalSetup` for any package whose tests send email.
 *
 * Unlike its database and blob store counterparts, this creates nothing. A mailbox needs no schema
 * and no bucket. It only checks Mailpit is there.
 */

import { loadLocalEnv, requireEnv } from '@gbd/core/env';

export async function setup(): Promise<void> {
  loadLocalEnv();
  const endpoint = requireEnv('EMAIL_ENDPOINT').replace(/\/+$/, '');

  const response = await fetch(`${endpoint}/api/v1/info`).catch((cause: unknown) => {
    throw new Error(
      `Could not reach Mailpit at ${endpoint}. Set '[local_smtp] enabled = true' in the stack's ` +
        'config.toml and restart it — see the README on starting the databases.',
      { cause },
    );
  });

  if (!response.ok) {
    throw new Error(`Mailpit answered ${response.status} at ${endpoint}`);
  }
}
