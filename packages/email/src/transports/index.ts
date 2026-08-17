import { exhaustiveArray } from '@gbd/core';
import type { EmailTransport } from '../client.ts';
import { mailpitTransport } from './mailpit.ts';
import { providerTransport } from './provider.ts';

export type TransportName = 'mailpit' | 'provider';

const TRANSPORT_NAMES = exhaustiveArray<TransportName>()(['mailpit', 'provider']);

export type RawTransportSettings = {
  name: string;
  endpoint: string | undefined;
};

export type TransportSettings = { name: 'mailpit'; endpoint: string } | { name: 'provider' };

/** Validate the raw environment settings, or throw naming what went wrong. */
export function parseTransportSettings(settings: RawTransportSettings): TransportSettings {
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
      return { name: 'mailpit', endpoint: settings.endpoint };
    }
    case 'provider':
      return { name: 'provider' };
  }
}

export function resolveTransport(settings: TransportSettings): EmailTransport {
  switch (settings.name) {
    case 'mailpit':
      return mailpitTransport({ endpoint: settings.endpoint });
    case 'provider':
      return providerTransport();
  }
}
