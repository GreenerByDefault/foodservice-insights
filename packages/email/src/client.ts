/** The emailer handle, and the transport seam under it. */

export type Address = {
  readonly address: string;
  readonly name: string;
};

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
  readonly from: Address;
  readonly to: string;
  readonly subject: string;
  /** The canonical copy. A transport that can only carry one body should send this one. */
  readonly text: string;
  /** The same copy through `layout()`. */
  readonly html: string;
};

/** The longest a transport may let one `send` run before it gives up. Part of the
 * `EmailTransport` contract rather than any one transport's detail: a caller that retries a send
 * has to know when the previous one can no longer be in flight, and it cannot ask the transport.
 *
 * Read by [`apps/worker/src/config.ts`](../../../apps/worker/src/config.ts), whose notification
 * retry delay has to exceed it — otherwise a retry goes out while the send it is retrying is still
 * open, and two workers have the same email in the air.
 */
export const MAX_SEND_DURATION_MS = 10_000;

export type EmailTransport = {
  /** For log lines, and for the error a stub transport raises when asked to send. */
  readonly name: string;
  /** Must reject rather than run longer than `MAX_SEND_DURATION_MS`. */
  send(email: RenderedEmail): Promise<void>;
};

export type EmailerConfig = {
  transport: EmailTransport;
  from: Address;
  /** The origin every link in an email is built against. A trailing slash is trimmed. */
  siteUrl: string;
  /** Where the GBD notices go. */
  gbdAddress: string;
  /** Where a user is told to write for help. */
  supportAddress: string;
};

export type EmailContext = {
  readonly from: Address;
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
