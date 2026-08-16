/** These paths must match `apps/web/src/routes/` — see that directory for the source of truth. */

import type { OrganizationId, ReportId, ResultFileId } from '@gbd/db';
import { describe, expect, test } from 'vitest';
import { recordingEmailer } from '../testing/recording.ts';
import { reportUrl, resultFileUrl, signInUrl, supportMailtoUrl } from './links.ts';

const emailer = recordingEmailer().service;
const ORGANIZATION_ID = 'org-id' as OrganizationId;
const REPORT_ID = 'report-id' as ReportId;

describe('reportUrl', () => {
  test('points at apps/web/src/routes/(app)/orgs/[organizationId]/reports/[reportId]', () => {
    expect(reportUrl(emailer, ORGANIZATION_ID, REPORT_ID)).toBe(
      'https://example.test/orgs/org-id/reports/report-id',
    );
  });
});

describe('resultFileUrl', () => {
  test('points at apps/web/src/routes/file/result/[id]', () => {
    expect(resultFileUrl(emailer, 'file-id' as ResultFileId)).toBe(
      'https://example.test/file/result/file-id',
    );
  });
});

describe('signInUrl', () => {
  test('points at apps/web/src/routes/sign-in with the address pre-filled', () => {
    expect(signInUrl(emailer, 'alice@example.test')).toBe(
      'https://example.test/sign-in?email=alice%40example.test',
    );
  });

  test('encodes an address so it survives as one query parameter', () => {
    expect(signInUrl(emailer, 'a+b@example.test')).toContain(
      encodeURIComponent('a+b@example.test'),
    );
  });
});

describe('supportMailtoUrl', () => {
  test('mailtos the configured support address', () => {
    expect(supportMailtoUrl(emailer)).toBe('mailto:support@example.test');
  });
});
