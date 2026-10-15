import { exhaustiveArray } from '@gbd/core';
import type { EmailTransport } from '../client.ts';
import { mailpitTransport } from './mailpit.ts';
import { postmarkTransport } from './postmark.ts';
import { providerTransport } from './provider.ts';

export type TransportName = 'mailpit' | 'postmark' | 'provider';

const TRANSPORT_NAMES = exhaustiveArray<TransportName>()(['mailpit', 'postmark', 'provider']);

export type RawTransportSettings = {
  name: string;
  endpoint: string | undefined;
  postmarkServerToken: string | undefined;
};

export type TransportSettings =
  | { name: 'mailpit'; endpoint: string }
  | { name: 'postmark'; serverToken: string }
  | { name: 'provider' };

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
    case 'postmark': {
      if (!settings.postmarkServerToken) {
        throw new Error(
          'EMAIL_TRANSPORT=postmark needs POSTMARK_SERVER_TOKEN, the Server API token.',
        );
      }
      return { name: 'postmark', serverToken: settings.postmarkServerToken };
    }
    case 'provider':
      return { name: 'provider' };
  }
}

export function resolveTransport(settings: TransportSettings): EmailTransport {
  switch (settings.name) {
    case 'mailpit':
      return mailpitTransport({ endpoint: settings.endpoint });
    case 'postmark':
      return postmarkTransport({ serverToken: settings.serverToken });
    case 'provider':
      return providerTransport();
  }
}
