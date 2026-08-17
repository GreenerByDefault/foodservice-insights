/** Reading mail back out of Mailpit.
 *
 * **Isolation is the recipient address, not a truncate.** Tests run concurrently against
 * the one Mailpit instance, which has no transactions to roll back, so emptying the mailbox
 * would delete another test's mail mid-run. Use `aTestEmailAddress()` for a unique recipient
 * per test and read only what was sent to it.
 *
 * `clearMailbox` therefore belongs to `pnpm truncate` alone, which runs between suites.
 *
 * See `../transports/mailpit.test.ts` for test coverage.
 */

import { loadLocalEnv, requireEnv } from '@gbd/core/env';

export type MailboxMessage = {
  id: string;
  from: string;
  to: readonly string[];
  subject: string;
  text: string;
  html: string;
};

/** A recipient nothing else in the suite will use. `.test` is reserved by RFC 2606, so a message
 * that escaped to a real network could not be delivered.
 */
export function aTestEmailAddress(label = 'test'): string {
  return `${label}-${crypto.randomUUID()}@example.test`;
}

function endpoint(): string {
  loadLocalEnv();
  return requireEnv('EMAIL_ENDPOINT').replace(/\/+$/, '');
}

async function callMailpit(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${endpoint()}${path}`, init);
  if (!response.ok) {
    throw new Error(`Mailpit answered ${response.status} for ${path}: ${await response.text()}`);
  }
  return response;
}

type SearchResult = { messages: ReadonlyArray<{ ID: string }> };
type MessageDetail = {
  ID: string;
  From: { Address: string };
  To: ReadonlyArray<{ Address: string }>;
  Subject: string;
  Text: string;
  HTML: string;
};

/** Every message sent to one address, newest first. */
export async function readMailbox(address: string): Promise<MailboxMessage[]> {
  const search = new URLSearchParams({ query: `to:${address}` });
  const found = (await (await callMailpit(`/api/v1/search?${search}`)).json()) as SearchResult;

  // The search result carries only a snippet, so each body is a second request. Fine at the one or
  // two messages a test sends to its own address.
  return await Promise.all(
    found.messages.map(async (summary) => {
      const detail = (await (
        await callMailpit(`/api/v1/message/${summary.ID}`)
      ).json()) as MessageDetail;
      return {
        id: detail.ID,
        from: detail.From.Address,
        to: detail.To.map((recipient) => recipient.Address),
        subject: detail.Subject,
        text: detail.Text,
        html: detail.HTML,
      };
    }),
  );
}

export type WaitOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
};

/** Wait until at least `count` messages have arrived for an address, and return them.
 *
 * Mailpit answers a send before it has finished storing the message, so reading straight after
 * sending sees too few often enough to matter. Waiting on a *count* rather than on presence is
 * what makes that safe.
 */
export async function waitForEmails(
  address: string,
  count: number,
  options: WaitOptions = {},
): Promise<MailboxMessage[]> {
  const { timeoutMs = 5_000, pollIntervalMs = 50 } = options;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const messages = await readMailbox(address);
    if (messages.length >= count) return messages;
    if (Date.now() >= deadline) {
      throw new Error(
        `Only ${messages.length} of ${count} emails arrived for ${address} within ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/** Wait for one message and return it. */
export async function waitForEmail(
  address: string,
  options: WaitOptions = {},
): Promise<MailboxMessage> {
  const [first] = await waitForEmails(address, 1, options);
  // `waitForEmails` returned, so it saw at least one.
  if (first === undefined) throw new Error(`No email arrived for ${address}`);
  return first;
}

/** Delete every message. Only for `pnpm truncate` — see this file's header. */
export async function clearMailbox(): Promise<void> {
  await callMailpit('/api/v1/messages', { method: 'DELETE' });
}
