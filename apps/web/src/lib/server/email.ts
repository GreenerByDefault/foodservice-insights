import { APP_NAME } from '@gbd/core';
import {
  type Emailer,
  type GbdOrganizationCreated,
  type GbdOrganizationDeleted,
  type GbdUserDeleted,
  initializeEmailer,
  parseTransportSettings,
  resolveTransport,
  sendEmail,
} from '@gbd/email';
import { env } from '$env/dynamic/private';
import { requireVar } from './env.ts';

let handle: Emailer | undefined;

/** The web app's emailer handle, built on first use.
 *
 * Lazy because the build imports this module to analyse the routes, with no env vars set.
 */
export function emailer(): Emailer {
  handle ??= initializeEmailer({
    transport: resolveTransport(
      parseTransportSettings({
        name: requireVar('EMAIL_TRANSPORT'),
        // Not `requireVar`: a `provider` transport needs no endpoint, and `parseTransportSettings`
        // is what enforces that `mailpit` has one.
        endpoint: env.EMAIL_ENDPOINT,
      }),
    ),
    from: { address: requireVar('EMAIL_FROM_ADDRESS'), name: APP_NAME },
    siteUrl: requireVar('SITE_URL'),
    gbdAddress: requireVar('EMAIL_GBD_ADDRESS'),
    supportAddress: requireVar('EMAIL_SUPPORT_ADDRESS'),
  });
  return handle;
}

/** A notice to GBD themselves, rather than to an end user. */
export type GbdNotice = GbdOrganizationCreated | GbdOrganizationDeleted | GbdUserDeleted;

/** Send a GBD notice, logging rather than throwing if it fails.
 *
 * Call this only after the transaction it reports on has committed: the thing it describes
 * already happened either way, and `packages/email` deliberately does not retry a failed send.
 */
export async function notifyGbd(message: GbdNotice): Promise<void> {
  try {
    await sendEmail(emailer(), message);
  } catch (cause) {
    console.error('Could not notify GBD', { kind: message.kind, error: cause });
  }
}
