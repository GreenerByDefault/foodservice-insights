/** Reading the violation reports browsers send to `/csp-report`.
 *
 * A report is cut down before it reaches the log: its URLs can carry query strings — an auth
 * callback's `code`, a search — and only where a violation happened is worth keeping.
 */

import * as v from 'valibot';

export type CspViolation = {
  directive: string;
  /** The blocked resource's origin, or a keyword such as `inline` or `eval` when it has none. */
  blocked: string;
  documentPath: string;
  /** The script that caused it, without its query string. */
  sourceFile?: string;
  line?: number;
};

/** Most real-world reports are an extension injecting into the page, which is not ours to fix. */
const EXTENSION_SCHEMES: readonly string[] = [
  'chrome-extension:',
  'moz-extension:',
  'safari-web-extension:',
];

/** The original `report-uri` body, which Chromium and Firefox send. Older browsers leave out
 * `effective-directive`, and their `violated-directive` is the whole directive, sources included. */
const LegacyReport = v.pipe(
  v.object({
    'csp-report': v.object({
      'document-uri': v.pipe(v.string(), v.url()),
      'effective-directive': v.optional(v.string()),
      'violated-directive': v.string(),
      'blocked-uri': v.optional(v.string(), ''),
      'source-file': v.nullish(v.string()),
      'line-number': v.nullish(v.number()),
    }),
  }),
  v.transform(
    ({ 'csp-report': report }): RawViolation => ({
      directive: report['effective-directive'] ?? report['violated-directive'].split(' ')[0] ?? '',
      blockedUrl: report['blocked-uri'],
      documentUrl: report['document-uri'],
      sourceFile: report['source-file'],
      line: report['line-number'],
    }),
  ),
);

/** Safari's, in the Reporting API's shape even though `report-uri`, not `report-to`, sent it. */
const SafariReport = v.pipe(
  v.object({
    type: v.literal('csp-violation'),
    body: v.object({
      documentURL: v.pipe(v.string(), v.url()),
      effectiveDirective: v.string(),
      blockedURL: v.nullish(v.string(), ''),
      sourceFile: v.nullish(v.string()),
      lineNumber: v.nullish(v.number()),
    }),
  }),
  v.transform(
    ({ body: report }): RawViolation => ({
      directive: report.effectiveDirective,
      blockedUrl: report.blockedURL,
      documentUrl: report.documentURL,
      sourceFile: report.sourceFile,
      line: report.lineNumber,
    }),
  ),
);

const ReportUriBody = v.union([LegacyReport, SafariReport]);

type RawViolation = {
  directive: string;
  blockedUrl: string;
  documentUrl: string;
  sourceFile: string | null | undefined;
  line: number | null | undefined;
};

/** `null` for a body that is not a violation report. */
export function parseCspReport(contentType: string | null, body: string): CspViolation[] | null {
  if (contentType?.split(';')[0]?.trim() !== 'application/csp-report') return null;

  const parsed = v.safeParse(ReportUriBody, parseJson(body));
  if (!parsed.success) return null;
  return isFromExtension(parsed.output) ? [] : [reduce(parsed.output)];
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function isFromExtension({ blockedUrl, sourceFile }: RawViolation): boolean {
  return EXTENSION_SCHEMES.some(
    (scheme) => blockedUrl.startsWith(scheme) || sourceFile?.startsWith(scheme),
  );
}

function reduce(raw: RawViolation): CspViolation {
  const source = raw.sourceFile ? URL.parse(raw.sourceFile) : null;
  return {
    directive: raw.directive,
    blocked: originOrKeyword(raw.blockedUrl),
    documentPath: new URL(raw.documentUrl).pathname,
    sourceFile: source ? `${source.origin}${source.pathname}` : undefined,
    line: raw.line ?? undefined,
  };
}

function originOrKeyword(blockedUrl: string): string {
  const url = URL.parse(blockedUrl);
  if (url === null) return blockedUrl;
  // A `data:` URI's origin is the string `null`, so its scheme is what says anything.
  return url.origin === 'null' ? url.protocol : url.origin;
}
