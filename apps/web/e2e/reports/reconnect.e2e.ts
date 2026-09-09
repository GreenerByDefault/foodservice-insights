/** The one thing no other layer can check: block the poll, and the timeline has to stay up and
 * say so — never a reload, never an error page.
 *
 * This is what the endpoint's existence stands on: SvelteKit's `invalidate()` falls back to a
 * full-page navigation when its own data request fails at the network level, which breaks the
 * page outright once the connection itself is the problem (see `README.md` § Routes). Polling a
 * dedicated `+server.ts` with a plain `fetch` avoids that.
 */

import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { makeReportUnreachable } from '../lib/reconnecting.ts';

test('an unreachable poll leaves the timeline up and shows a reconnecting notice, never a reload', async ({
  page,
  reports,
  org,
}) => {
  const loads = await makeReportUnreachable(page, reports, org);

  await expect(page.getByText('We lost the connection', { exact: false })).toBeVisible();
  await expect(page.getByText('You can close this page', { exact: false })).toBeVisible();
  expect(loads.count).toBe(0);
});
