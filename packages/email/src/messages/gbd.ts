/** The three notices to GBD, per REQUIREMENTS.md § GBD email notifications.
 *
 * None carries a `to`: they all go to `emailer.gbdAddress`, which is the one place that address is
 * configured. A caller that could choose the recipient could send one of these to a customer.
 */

import type { Document } from './layout.ts';

export type GbdOrganizationCreated = {
  kind: 'gbd-organization-created';
  organizationName: string;
  /** The user who created it. */
  actorEmail: string;
};

export type GbdOrganizationDeleted = {
  kind: 'gbd-organization-deleted';
  organizationName: string;
  /** The admin who deleted it. */
  actorEmail: string;
};

export type GbdUserDeleted = {
  kind: 'gbd-user-deleted';
  /** The account that was deleted, not whoever deleted it — only a user may delete their own. */
  userEmail: string;
};

export function renderGbdOrganizationCreated(message: GbdOrganizationCreated): Document {
  return {
    heading: `New organization: ${message.organizationName}`,
    blocks: [
      {
        block: 'facts',
        facts: [
          ['Organization', message.organizationName],
          ['Created by', message.actorEmail],
        ],
      },
    ],
  };
}

export function renderGbdOrganizationDeleted(message: GbdOrganizationDeleted): Document {
  return {
    heading: `Organization deleted: ${message.organizationName}`,
    blocks: [
      {
        block: 'paragraph',
        text: 'Its reports and input files were deleted with it. No user accounts were.',
      },
      {
        block: 'facts',
        facts: [
          ['Organization', message.organizationName],
          ['Deleted by', message.actorEmail],
        ],
      },
    ],
  };
}

export function renderGbdUserDeleted(message: GbdUserDeleted): Document {
  return {
    heading: `User deleted: ${message.userEmail}`,
    blocks: [
      {
        block: 'paragraph',
        text: 'Their reports remain with their organizations, showing a deleted user as the submitter.',
      },
      { block: 'facts', facts: [['Account', message.userEmail]] },
    ],
  };
}
