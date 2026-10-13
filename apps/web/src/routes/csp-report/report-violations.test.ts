import { describe, expect, test } from 'vitest';
import { SERVER_LOGS } from '#lib/server/testing/logs.js';
import { _reportViolations } from './+server.ts';

const A_REPORT = JSON.stringify({
  'csp-report': {
    'document-uri': 'https://app.example/orgs',
    'effective-directive': 'connect-src',
    'violated-directive': 'connect-src',
    'blocked-uri': 'https://example.com/',
  },
});

function aRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://app.example/csp-report', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/csp-report',
      'content-length': String(new TextEncoder().encode(body).length),
      ...headers,
    },
  });
}

describe('_reportViolations', () => {
  test('logs each violation at warn', async () => {
    const response = await _reportViolations(aRequest(A_REPORT));

    expect(response.status).toBe(204);
    expect(SERVER_LOGS.records).toEqual([
      {
        level: 'warn',
        msg: 'CSP violation',
        directive: 'connect-src',
        blocked: 'https://example.com',
        documentPath: '/orgs',
      },
    ]);
  });

  test('accepts a report with nothing left to log', async () => {
    const extensionReport = A_REPORT.replace('https://example.com/', 'chrome-extension://abc/');

    const response = await _reportViolations(aRequest(extensionReport));

    expect(response.status).toBe(204);
    expect(SERVER_LOGS.records).toEqual([]);
  });

  test('400s a body it cannot read', async () => {
    const response = await _reportViolations(aRequest('{'));

    expect(response.status).toBe(400);
    expect(SERVER_LOGS.records).toEqual([]);
  });

  describe('the declared length', () => {
    test.each([
      ['missing', undefined],
      ['over 64 KiB', String(64 * 1024 + 1)],
      ['not a number', 'lots'],
    ])('413s one %s, without reading the body', async (_situation, contentLength) => {
      const request = aRequest(A_REPORT);
      if (contentLength === undefined) request.headers.delete('content-length');
      else request.headers.set('content-length', contentLength);

      const response = await _reportViolations(request);

      expect(response.status).toBe(413);
      expect(request.bodyUsed).toBe(false);
    });
  });
});
