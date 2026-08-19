/** Test that an upload is judged by our own rules rather than by the transport underneath them.
 *
 * `BODY_SIZE_LIMIT` only exists in the built server, and only when `start.js` is what started it —
 * so this is the one place the wiring can be checked.
 *
 * The rest of the upload rules are covered against the test database in `create-report.test.ts`.
 */

import { PLACEHOLDER_ORGANIZATION_ID } from '@gbd/db/seed';
import { expect, test } from '@playwright/test';
import { UNEXPECTED_ERROR_MESSAGE } from '../src/lib/errors/messages';
import { MAX_UPLOAD_BYTES, TRANSPORT_MARGIN_BYTES } from '../src/lib/reports/upload-limit.js';

const ENDPOINT = `/api/orgs/${PLACEHOLDER_ORGANIZATION_ID}/reports`;

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
    file: { name: 'procurement.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) },
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
}) => {
  const csv = csvOfAtLeast(MAX_UPLOAD_BYTES / 2);
  const response = await request.post(ENDPOINT, uploadRequestOptions(csv, baseURL as string));

  expect(response.status()).toBe(201);
  expect(await response.json()).toMatchObject({ reportId: expect.any(String) });
});

test('rejects a file over the product limit as our own 400, not the transport 413', async ({
  request,
  baseURL,
}) => {
  const csv = csvOfAtLeast(MAX_UPLOAD_BYTES + TRANSPORT_MARGIN_BYTES / 2);
  const response = await request.post(ENDPOINT, uploadRequestOptions(csv, baseURL as string));

  expect(response.status()).toBe(400);
  expect(await response.json()).toMatchObject({
    summary: 'That file is larger than 10MB.',
  });
});

test('rejects a file over the transport limit as adapter-node, not our own validation', async ({
  request,
  baseURL,
}) => {
  const csv = csvOfAtLeast(MAX_UPLOAD_BYTES + TRANSPORT_MARGIN_BYTES + 512 * 1024);
  const response = await request.post(ENDPOINT, uploadRequestOptions(csv, baseURL as string));

  expect(response.status()).toBe(413);
  expect(await response.json()).toMatchObject({ message: UNEXPECTED_ERROR_MESSAGE });
});
