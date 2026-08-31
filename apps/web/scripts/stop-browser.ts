/** Stop the shared screenshot browser container by hand.
 *
 * `startBrowserServer` reuses a live container across runs (see `e2e/setup/browser-container.ts`),
 * so nothing stops it locally between screenshot runs. Use this after screenshot work to free the
 * memory it holds.
 *
 *   pnpm test:browser:stop
 */

import { stopBrowserServer } from '../e2e/setup/browser-container.ts';

await stopBrowserServer();
