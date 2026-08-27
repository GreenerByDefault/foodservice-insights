import { test as teardown } from '@playwright/test';
import { stopBrowserServer } from './lib/browser-container';

teardown('the browser container is stopped', async () => {
  await stopBrowserServer();
});
