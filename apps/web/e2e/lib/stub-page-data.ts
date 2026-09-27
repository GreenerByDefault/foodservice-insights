import type { Page } from '@playwright/test';

/** Rewrite `/orgs`'s next client-side page-data fetch so its `organizations` array comes back
 * empty — the only way to see that screen. A user who belongs to no organization is redirected
 * to `/orgs/new` (`_organizationsPageRedirect`), so only a superadmin can reach the empty list,
 * and a superadmin's branch reads the whole `organization` table, which the run database is never
 * empty of. No fixture can produce this page; only a stubbed response can.
 *
 * Only a client-side navigation asks for `__data.json` — a `page.goto` is server-rendered and
 * never requests it, so this has no effect until something like `page.goBack()` or an in-app
 * `<a>` click triggers one.
 *
 * Edits the real response rather than fabricating one: SvelteKit's data payload devalue-encodes
 * each load node as `data[0]` (the root object) plus every value `data[0]` points to as further
 * elements of the same array, so the *value* an `organizations` key points to is just another
 * array element to empty out. Inventing a whole payload would pin this test to the wire format we
 * don't own (see `@sveltejs/kit/src/runtime/server/page/data_serializer.js`).
 */
export async function stubOrganizationsAsEmpty(page: Page): Promise<void> {
  await page.route('**/orgs/__data.json*', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    for (const node of payload.nodes) {
      if (node?.type !== 'data') continue;
      const index = node.data[0]?.organizations;
      if (typeof index === 'number') node.data[index] = [];
    }
    await route.fulfill({ response, json: payload });
  });
}
