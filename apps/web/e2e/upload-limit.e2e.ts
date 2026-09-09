/** Test that an upload is judged by our own rules rather than by the transport underneath them.
 *
 * `BODY_SIZE_LIMIT` only exists in the built server, and only when `start.js` is what started it —
 * so this is the one place the wiring can be checked.
 *
 * The rest of the upload rules are covered against the test database in `create-report.test.ts`.
 */

import type { ReportId } from '@gbd/db';
import { PLACEHOLDER_ORGANIZATION_SLUG } from '@gbd/db/seed';
import { expect } from '@playwright/test';
import { UNEXPECTED_ERROR_MESSAGE } from '../src/lib/errors/messages';
import { MAX_UPLOAD_FIELD_BYTES, TRANSPORT_MARGIN_BYTES } from '../src/lib/reports/upload-limit.js';
import { test } from './fixtures/test.ts';

const ENDPOINT = `/api/orgs/${PLACEHOLDER_ORGANIZATION_SLUG}/reports`;

const HEADER = 'product name,date ordered,weight\n';
const ROW = 'beef mince,2026-01-05,12\n';

function csvOfAtLeast(bytes: number): string {
  return HEADER + ROW.repeat(Math.ceil((bytes - HEADER.length) / ROW.length));
}

/** The metadata a submission needs, as `readSubmission` names the fields. */
function submission(csv: string) {
  return {
    'report-name': 'Q1 procurement',
    'counts-basis': 'people',
    'unit-system': 'kg',
    'monthly-counts': JSON.stringify({ '2026-01': 120 }),
    'csv-file': { name: 'procurement.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) },
  };
}

function uploadRequestOptions(csv: string, baseURL: string) {
  return {
    multipart: submission(csv),
    // SvelteKit answers a cross-site POST with 403 before any handler runs, and the request
    // fixture sends no origin of its own.
    headers: { origin: baseURL },
  };
}

test('accepts a file far past the Svelte default but inside the product limit', async ({
  request,
  baseURL,
  reports,
}) => {
  const csv = csvOfAtLeast(MAX_UPLOAD_FIELD_BYTES / 2);
  const response = await request.post(ENDPOINT, uploadRequestOptions(csv, baseURL as string));

  expect(response.status()).toBe(201);
  const body = await response.json();
  expect(body).toEqual({ reportId: expect.any(String) });
  reports.adopt(body.reportId as ReportId);
});

test('rejects a file over the product limit as our own 400, not the transport 413', async ({
  request,
  baseURL,
}) => {
  // `BODY_SIZE_LIMIT` is sized for the CSV field plus, when there is one, the workbook side-car —
  // even though this request sends only the CSV field. Sized past `MAX_UPLOAD_FIELD_BYTES` by
  // more than `TRANSPORT_MARGIN_BYTES` alone would allow, so the rejection below can only be
  // ours, never the transport's.
  const csv = csvOfAtLeast(MAX_UPLOAD_FIELD_BYTES + TRANSPORT_MARGIN_BYTES + 512 * 1024);
  const response = await request.post(ENDPOINT, uploadRequestOptions(csv, baseURL as string));

  expect(response.status()).toBe(400);
  expect(await response.json()).toEqual({
    summary: 'That file is larger than 10MB.',
  });
});

test('rejects a file over the transport limit as adapter-node, not our own validation', async ({
  request,
  baseURL,
}) => {
  const csv = csvOfAtLeast(MAX_UPLOAD_FIELD_BYTES * 2 + TRANSPORT_MARGIN_BYTES + 512 * 1024);
  const response = await request.post(ENDPOINT, uploadRequestOptions(csv, baseURL as string));

  expect(response.status()).toBe(413);
  expect(await response.json()).toEqual({ message: UNEXPECTED_ERROR_MESSAGE });
});
