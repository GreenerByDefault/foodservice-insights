import { test as teardown } from '@playwright/test';
import { stopBrowserServer } from './browser-container';

// Local runs share the container across invocations (see `startBrowserServer`); stopping it here
// would make every run pay to reclaim it. CI gives each run a fresh runner, so there's nothing to
// share and no reason to leave one behind.
teardown('the browser container is stopped', async () => {
  if (!process.env.CI) return;

  await stopBrowserServer();
});
