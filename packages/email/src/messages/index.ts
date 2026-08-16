/** Every email we send, and the one function that turns one into bytes.
 *
 * A caller says what happened; it never says what the email looks like or who receives it beyond
 * the address the event is about. That is what lets the copy, the layout, and the provider all
 * change without touching `apps/web` or `apps/worker`.
 */

import { assertNever } from '@gbd/core';
import type { EmailContext, RenderedEmail } from '../client.ts';
import type { AnalysisFailed, AnalysisSucceeded } from './analysis.ts';
import { renderAnalysisFailed, renderAnalysisSucceeded } from './analysis.ts';
import type { GbdOrganizationCreated, GbdOrganizationDeleted, GbdUserDeleted } from './gbd.ts';
import {
  renderGbdOrganizationCreated,
  renderGbdOrganizationDeleted,
  renderGbdUserDeleted,
} from './gbd.ts';
import type { OrganizationInvite } from './invite.ts';
import { renderOrganizationInvite } from './invite.ts';
import type { Document } from './layout.ts';
import { renderHtml, renderText } from './layout.ts';

export type EmailMessage =
  | AnalysisSucceeded
  | AnalysisFailed
  | OrganizationInvite
  | GbdOrganizationCreated
  | GbdOrganizationDeleted
  | GbdUserDeleted;

/** Who the message goes to. The GBD notices carry no `to`, so this is the only place their
 * recipient is decided.
 */
function recipient(context: EmailContext, message: EmailMessage): string {
  switch (message.kind) {
    case 'analysis-succeeded':
    case 'analysis-failed':
    case 'organization-invite':
      return message.to;
    case 'gbd-organization-created':
    case 'gbd-organization-deleted':
    case 'gbd-user-deleted':
      return context.gbdAddress;
    default:
      return assertNever(message);
  }
}

function describe(context: EmailContext, message: EmailMessage): Document {
  switch (message.kind) {
    case 'analysis-succeeded':
      return renderAnalysisSucceeded(context, message);
    case 'analysis-failed':
      return renderAnalysisFailed(context, message);
    case 'organization-invite':
      return renderOrganizationInvite(context, message);
    case 'gbd-organization-created':
      return renderGbdOrganizationCreated(message);
    case 'gbd-organization-deleted':
      return renderGbdOrganizationDeleted(message);
    case 'gbd-user-deleted':
      return renderGbdUserDeleted(message);
    default:
      return assertNever(message);
  }
}

/** Turn a message into the email a transport can send. Pure, so a test — or a future preview
 * route — can look at what we would send without sending it.
 */
export function render(context: EmailContext, message: EmailMessage): RenderedEmail {
  const document = describe(context, message);
  return {
    kind: message.kind,
    from: context.from,
    to: recipient(context, message),
    // One string is both, so an email's subject can never disagree with its own heading.
    subject: document.heading,
    text: renderText(document),
    html: renderHtml(document),
  };
}

export type { AnalysisFailed, AnalysisSucceeded, ResultFileLink } from './analysis.ts';
export type { GbdOrganizationCreated, GbdOrganizationDeleted, GbdUserDeleted } from './gbd.ts';
export type { OrganizationInvite } from './invite.ts';
