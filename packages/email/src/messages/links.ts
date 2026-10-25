/** The links our emails point at.
 *
 * `apps/web/src/lib/hrefs.ts` is the source of truth for these paths. The three org- and
 * report-scoped ones are rebuilt here because an email has no app to import from; the report link
 * is guarded by the system e2e, which follows it (`tests/e2e/specs/report-lifecycle.e2e.ts`).
 *
 * Every link is absolute, because an email has no origin to be relative to.
 */

import type { ReportId, ResultFileId } from '@gbd/db';
import type { EmailContext } from '../client.ts';

/** A URL built by this module, i.e. not from user input. */
export type TrustedUrl = string & { readonly brand: unique symbol };

function trustedUrl(url: string): TrustedUrl {
  return url as TrustedUrl;
}

export function reportUrl(
  context: EmailContext,
  organizationSlug: string,
  reportId: ReportId,
): TrustedUrl {
  return trustedUrl(`${context.siteUrl}/orgs/${organizationSlug}/reports/${reportId}`);
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
