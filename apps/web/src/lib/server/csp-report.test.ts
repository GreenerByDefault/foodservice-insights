import { describe, expect, test } from 'vitest';
import { parseCspReport } from './csp-report.ts';

/** What Firefox sends to `report-uri` for `fetch('https://example.com/search?q=secret')` from the members page. */
function aLegacyReport(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    'csp-report': {
      'document-uri': 'https://app.example/orgs/acme/members?tab=pending',
      referrer: '',
      'violated-directive': 'connect-src',
      'effective-directive': 'connect-src',
      'original-policy': "default-src 'self'; connect-src 'self'",
      disposition: 'enforce',
      'blocked-uri': 'https://example.com/search?q=secret',
      'line-number': 12,
      'column-number': 3,
      'source-file': 'https://app.example/_app/immutable/chunks/app.js?v=1',
      'status-code': 200,
      'script-sample': '',
      ...overrides,
    },
  });
}

/** The same violation as Safari sends it, with `overrides` applied to its `body`. */
function aReportingApiReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'csp-violation',
    age: 10,
    url: 'https://app.example/orgs/acme/members?tab=pending',
    user_agent: 'Mozilla/5.0',
    body: {
      documentURL: 'https://app.example/orgs/acme/members?tab=pending',
      referrer: '',
      effectiveDirective: 'connect-src',
      originalPolicy: "default-src 'self'; connect-src 'self'",
      disposition: 'enforce',
      blockedURL: 'https://example.com/search?q=secret',
      lineNumber: 12,
      columnNumber: 3,
      sourceFile: 'https://app.example/_app/immutable/chunks/app.js?v=1',
      statusCode: 200,
      sample: '',
      ...overrides,
    },
  };
}

const THE_VIOLATION = {
  directive: 'connect-src',
  blocked: 'https://example.com',
  documentPath: '/orgs/acme/members',
  sourceFile: 'https://app.example/_app/immutable/chunks/app.js',
  line: 12,
};

describe('parseCspReport', () => {
  test('reduces the report to where the violation happened', () => {
    expect(parseCspReport('application/csp-report', aLegacyReport())).toEqual([THE_VIOLATION]);
  });

  test('takes the directive from violated-directive when effective-directive is missing', () => {
    const body = aLegacyReport({
      'effective-directive': undefined,
      'violated-directive': "connect-src 'self'",
    });

    expect(parseCspReport('application/csp-report', body)).toEqual([THE_VIOLATION]);
  });

  test('accepts a charset on the content type', () => {
    expect(parseCspReport('application/csp-report; charset=utf-8', aLegacyReport())).toEqual([
      THE_VIOLATION,
    ]);
  });

  describe("Safari's report, in the Reporting API's shape", () => {
    test('reduces it the same way', () => {
      const body = JSON.stringify(aReportingApiReport());

      expect(parseCspReport('application/csp-report', body)).toEqual([THE_VIOLATION]);
    });

    test('leaves out a location the browser reports as null', () => {
      const body = JSON.stringify(aReportingApiReport({ sourceFile: null, lineNumber: null }));

      expect(parseCspReport('application/csp-report', body)).toEqual([
        {
          directive: 'connect-src',
          blocked: 'https://example.com',
          documentPath: '/orgs/acme/members',
        },
      ]);
    });
  });

  describe('the blocked resource', () => {
    test.each([
      ['inline', 'inline'],
      ['eval', 'eval'],
      ['data:image/png;base64,AAAA', 'data:'],
      ['blob:https://app.example/1234', 'https://app.example'],
    ])('reports %s as %s', (blockedUri, blocked) => {
      const body = aLegacyReport({ 'blocked-uri': blockedUri });

      expect(parseCspReport('application/csp-report', body)).toEqual([
        { ...THE_VIOLATION, blocked },
      ]);
    });
  });

  describe('a browser extension', () => {
    test.each([
      ['blocked-uri', 'chrome-extension:'],
      ['blocked-uri', 'moz-extension:'],
      ['source-file', 'safari-web-extension:'],
    ])('drops a report whose %s is a %s URL', (field, scheme) => {
      const body = aLegacyReport({ [field]: `${scheme}//abcdef/content.js` });

      expect(parseCspReport('application/csp-report', body)).toEqual([]);
    });
  });

  describe('a body it cannot read', () => {
    test.each([
      ['invalid JSON', 'application/csp-report', '{'],
      [
        'a report missing its document',
        'application/csp-report',
        aLegacyReport({ 'document-uri': undefined }),
      ],
      [
        'a document that is not a URL',
        'application/csp-report',
        aLegacyReport({ 'document-uri': 'about' }),
      ],
      [
        'a report of another type',
        'application/csp-report',
        JSON.stringify({ type: 'deprecation', body: {} }),
      ],
      ['a batch', 'application/csp-report', JSON.stringify([aReportingApiReport()])],
      ['another content type', 'application/reports+json', aLegacyReport()],
      ['no content type', null, aLegacyReport()],
    ])('returns null for %s', (_situation, contentType, body) => {
      expect(parseCspReport(contentType, body)).toBeNull();
    });
  });
});
