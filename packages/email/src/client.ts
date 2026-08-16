/** The emailer handle, and the transport seam under it. */

/** Lives here rather than beside the message payloads because it is part of what a transport sees.
 * A message whose `kind` is missing from this union fails to compile in `render`.
 */
export type EmailMessageKind =
  | 'analysis-succeeded'
  | 'analysis-failed'
  | 'organization-invite'
  | 'gbd-organization-created'
  | 'gbd-organization-deleted'
  | 'gbd-user-deleted';

/** One email, fully rendered and ready to hand to a transport. */
export type RenderedEmail = {
  /** Survives rendering because it is the only field a transport or a log line can group by: a
   * provider's tags and message streams want it, and so does a test asserting *which* email was
   * sent without matching on copy that is going to be rewritten. */
  readonly kind: EmailMessageKind;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  /** The canonical copy. A transport that can only carry one body should send this one. */
  readonly text: string;
  /** The same copy through `layout()`. */
  readonly html: string;
};

/** Where email actually goes — the one seam between this package and the sending service. Why it
 * is shaped like this, and what choosing a provider costs, is in `transports/provider.ts`.
 */
export type EmailTransport = {
  /** For log lines, and for the error a stub transport raises when asked to send. */
  readonly name: string;
  send(email: RenderedEmail): Promise<void>;
};

export type EmailerConfig = {
  transport: EmailTransport;
  /** The sender, as a full address: `Foodservice Insights <noreply@example.org>`. */
  from: string;
  /** The origin every link in an email is built against. A trailing slash is trimmed. */
  siteUrl: string;
  /** Where the GBD notices go — see REQUIREMENTS.md § GBD email notifications. */
  gbdAddress: string;
};

export type EmailContext = {
  readonly from: string;
  readonly siteUrl: string;
  readonly gbdAddress: string;
};

export type Emailer = EmailContext & {
  readonly transport: EmailTransport;
};

/** Build an emailer. This connects to nothing; a transport only reaches the network on a `send`. */
export function initializeEmailer(config: EmailerConfig): Emailer {
  return {
    transport: config.transport,
    from: config.from,
    // Trimmed here rather than at every call site, so `${siteUrl}${path}` is always right.
    siteUrl: config.siteUrl.replace(/\/+$/, ''),
    gbdAddress: config.gbdAddress,
  };
}
