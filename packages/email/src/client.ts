/** The emailer handle, and the transport seam under it. */

export type EmailMessageKind =
  | 'analysis-succeeded'
  | 'analysis-failed'
  | 'organization-invite'
  | 'gbd-organization-created'
  | 'gbd-organization-deleted'
  | 'gbd-user-deleted';

/** One email, fully rendered and ready to hand to a transport. */
export type RenderedEmail = {
  /** This allows us to report which email kind was used. */
  readonly kind: EmailMessageKind;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  /** The canonical copy. A transport that can only carry one body should send this one. */
  readonly text: string;
  /** The same copy through `layout()`. */
  readonly html: string;
};

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
  /** Where the GBD notices go. */
  gbdAddress: string;
  /** Where a user is told to write for help. */
  supportAddress: string;
};

export type EmailContext = {
  readonly from: string;
  readonly siteUrl: string;
  readonly gbdAddress: string;
  readonly supportAddress: string;
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
    supportAddress: config.supportAddress,
  };
}
