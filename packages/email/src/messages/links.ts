/** The links our emails point at.
 *
 * `apps/web/src/routes/` is the source of truth for these paths; they are rebuilt here rather than
 * imported because the web app writes its own hrefs inline in Svelte today. When it grows a shared
 * route module, these move there and this file goes away.
 *
 * Every link is absolute, because an email has no origin to be relative to.
 */

import type { OrganizationId, ReportId, ResultFileId } from '@gbd/db';
import type { Emailer } from '../client.ts';

export function reportUrl(
  emailer: Emailer,
  organizationId: OrganizationId,
  reportId: ReportId,
): string {
  return `${emailer.siteUrl}/orgs/${organizationId}/reports/${reportId}`;
}

/** The stable, unauthenticated download link — see `apps/web/src/routes/file/result/[id=uuid]/`. */
export function resultFileUrl(emailer: Emailer, resultFileId: ResultFileId): string {
  return `${emailer.siteUrl}/file/result/${resultFileId}`;
}

/** Sign-in with the address pre-filled. Deliberately carries no token: per REQUIREMENTS.md's invite
 * flow, forwarding this link grants nobody anything, because only OTP to that address does.
 */
export function signInUrl(emailer: Emailer, email: string): string {
  return `${emailer.siteUrl}/sign-in?email=${encodeURIComponent(email)}`;
}
