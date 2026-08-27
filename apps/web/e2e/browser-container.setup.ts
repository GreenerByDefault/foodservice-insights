import { expect, test as setup } from '@playwright/test';
import { BROWSER_IMAGE, describeBrowser, startBrowserServer } from './lib/browser-container';

// A dependency of the `screenshots` project, so the behavioural e2e suite never pays for Docker.
setup('the pinned browser container is serving', async () => {
  // First run on a machine pulls the image, which is measured in gigabytes.
  setup.setTimeout(600_000);

  await startBrowserServer();

  // Printed because it is the first thing to check when a diff appears that nobody caused.
  const browser = await describeBrowser();
  console.log(`Screenshots will be captured by ${browser} from ${BROWSER_IMAGE}`);
  expect(browser).toContain('chromium');
});
