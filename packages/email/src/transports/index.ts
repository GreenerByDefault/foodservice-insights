import { exhaustiveArray } from '@gbd/core';
import type { EmailTransport } from '../client.ts';
import { mailpitTransport } from './mailpit.ts';
import { providerTransport } from './provider.ts';

/** What `EMAIL_TRANSPORT` may be set to. */
export type TransportName = 'mailpit' | 'provider';

const TRANSPORT_NAMES = exhaustiveArray<TransportName>()(['mailpit', 'provider']);

export type TransportSettings = {
  /** `EMAIL_TRANSPORT`, unvalidated — this is where it gets checked. */
  name: string;
  /** `EMAIL_ENDPOINT`. Required by `mailpit`. */
  endpoint?: string | undefined;
};

/** Build the transport the environment asks for.
 *
 * Shared by `env.ts` and by the web app, which reads the same variables through
 * `$env/dynamic/private` instead and so cannot use `env.ts` — see the rule in
 * `.claude/rules/typescript.md`.
 */
export function resolveTransport(settings: TransportSettings): EmailTransport {
  const name = TRANSPORT_NAMES.find((candidate) => candidate === settings.name);
  if (name === undefined) {
    throw new Error(
      `Unknown EMAIL_TRANSPORT '${settings.name}'. Expected one of: ${TRANSPORT_NAMES.join(', ')}.`,
    );
  }

  switch (name) {
    case 'mailpit': {
      if (!settings.endpoint) {
        throw new Error("EMAIL_TRANSPORT=mailpit needs EMAIL_ENDPOINT, Mailpit's HTTP origin.");
      }
      return mailpitTransport({ endpoint: settings.endpoint });
    }
    case 'provider':
      return providerTransport();
  }
}
