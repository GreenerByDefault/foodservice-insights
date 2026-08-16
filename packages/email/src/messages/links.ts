/** The links our emails point at.
 *
 * `apps/web/src/routes/` is the source of truth for these paths; they are rebuilt here rather than
 * imported because the web app writes its own hrefs inline in Svelte today. When it grows a shared
 * route module, these move there and this file goes away.
 *
 * Every link is absolute, because an email has no origin to be relative to.
 */

import type { OrganizationId, ReportId, ResultFileId } from '@gbd/db';
import type { EmailContext } from '../client.ts';

/** A URL built by this module, i.e. not from user input. */
export type TrustedUrl = string & { readonly brand: unique symbol };

function trustedUrl(url: string): TrustedUrl {
  return url as TrustedUrl;
}

export function reportUrl(
  context: EmailContext,
  organizationId: OrganizationId,
  reportId: ReportId,
): TrustedUrl {
  return trustedUrl(`${context.siteUrl}/orgs/${organizationId}/reports/${reportId}`);
}

/** The stable, unauthenticated download link — see `apps/web/src/routes/file/result/[id=uuid]/`. */
export function resultFileUrl(context: EmailContext, resultFileId: ResultFileId): TrustedUrl {
  return trustedUrl(`${context.siteUrl}/file/result/${resultFileId}`);
}

/** Sign-in with the address pre-filled. */
export function signInUrl(context: EmailContext, email: string): TrustedUrl {
  return trustedUrl(`${context.siteUrl}/sign-in?email=${encodeURIComponent(email)}`);
}

export function supportMailtoUrl(context: EmailContext): TrustedUrl {
  return trustedUrl(`mailto:${context.supportAddress}`);
}
