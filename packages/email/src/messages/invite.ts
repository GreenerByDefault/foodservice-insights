/** The email an admin's invitation sends, per REQUIREMENTS.md § Invite flow. */

import { APP_NAME } from '@gbd/core';
import type { OrganizationRole } from '@gbd/db';
import type { EmailContext } from '../client.ts';
import type { Document } from './layout.ts';
import { signInUrl } from './links.ts';

export type OrganizationInvite = {
  kind: 'organization-invite';
  to: string;
  organizationName: string;
  role: OrganizationRole;
  /** The admin who sent it. Null when they have not set a display name. */
  invitedByName: string | null;
  expiresAt: Date;
};

const ROLE_LABELS: Record<OrganizationRole, string> = {
  member: 'Member',
  admin: 'Admin',
};

/** UTC, so the copy does not depend on where the sending process happens to run. Everyone reading
 * an expiry two weeks out is served better by a stable date than by a local one.
 */
const EXPIRY_FORMAT = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' });

export function renderOrganizationInvite(
  context: EmailContext,
  message: OrganizationInvite,
): Document {
  const inviter = message.invitedByName ?? 'An admin';

  return {
    heading: `Join ${message.organizationName} on ${APP_NAME}`,
    blocks: [
      {
        block: 'paragraph',
        text: `${inviter} invited you to join ${message.organizationName}. Sign in with this email address to accept.`,
      },
      { block: 'action', label: 'Accept the invitation', url: signInUrl(context, message.to) },
      {
        block: 'facts',
        facts: [
          ['Organization', message.organizationName],
          ['Role', ROLE_LABELS[message.role]],
          ['Expires', EXPIRY_FORMAT.format(message.expiresAt)],
        ],
      },
      // The link carries no token by design, so it is worth telling the reader that forwarding it
      // achieves nothing — otherwise the natural assumption is the opposite.
      {
        block: 'paragraph',
        text: 'Only someone signed in as this email address can accept, so forwarding this message does not pass the invitation on.',
      },
    ],
  };
}
