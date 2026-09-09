/** Wraps `playwright test` via `@gbd/browser-testing/test-run` — see that module for the per-run
 * database/bucket lifecycle, shared with `apps/web/scripts/test-run.ts`. What this suite adds is
 * everything the *system* tier needs alive before the browser starts: the two service images
 * built by `containers.ts` and running against the run's database and bucket, and a mailbox only
 * this run sends to.
 *
 * `pnpm test:system` routes through this rather than calling `playwright test` directly —
 * `playwright.config.ts` throws if it detects a bare invocation, via the `TEST_RUN_ID` this sets
 * and the images this builds.
 *
 * Every CLI argument passed to this script is forwarded to `playwright test` verbatim.
 */

import {
  type BeforePlaywrightResult,
  blobStoreConfigFromEnv,
  type FreshStack,
  installCleanupSignalHandlers,
  resolvePlaywrightBin,
  runAgainstFreshStack,
} from '@gbd/browser-testing/test-run';
import { findRepoRoot, loadLocalEnv, requireEnv } from '@gbd/core/env';
import { aTestEmailAddress } from '@gbd/email/testing';
import {
  assertDockerIsUsable,
  buildContainerImages,
  removeRunResources,
  startWorkerContainer,
  sweepStaleContainers,
} from './containers.ts';

const REPO_ROOT = findRepoRoot();

/** The worker runs as its own container, not an in-process import: `apps/worker/src/db.ts`,
 * `@gbd/storage/env` and `@gbd/email/env` all read their environment at *import* time, so the
 * run's database and bucket have to be in place before the module graph loads.
 *
 * Nothing is shared by filesystem — the input CSV and the result files both move through the blob
 * store — so the image's own `WORKER_RUN_ROOT` is used as-is. That is deliberate: its writability
 * as uid 1001 is one of the things this tier exists to prove.
 */
async function startServices(stack: FreshStack): Promise<BeforePlaywrightResult> {
  // Everything this run creates in Docker is named for `stack.name`, so two worktrees running at
  // once cannot race a shared tag, and one teardown call reaches all of it.
  const containerImages = await buildContainerImages(REPO_ROOT, stack.name);
  const worker = startWorkerContainer({
    image: containerImages.worker,
    runName: stack.name,
    stack,
  });

  return {
    env: {
      SYSTEM_E2E_WEB_IMAGE: containerImages.web,
      SYSTEM_E2E_WORKER_IMAGE: containerImages.worker,
    },
    afterPlaywright: async () => {
      await worker.stop();
      // Owned here rather than trusted to Playwright's own teardown of the web container — see
      // `OWNER_LABEL` in `containers.ts` for why a killed run can't be relied on to clean up
      // itself.
      await removeRunResources(stack.name);
    },
  };
}

async function main(): Promise<void> {
  loadLocalEnv();
  installCleanupSignalHandlers();
  await assertDockerIsUsable();

  const swept = await sweepStaleContainers();
  if (swept > 0) console.log(`swept ${swept} stale container(s) and image tag(s)`);

  process.exitCode = await runAgainstFreshStack({
    connectionString: requireEnv('DB_CONNECTION_STRING'),
    s3: blobStoreConfigFromEnv(),
    playwrightBin: resolvePlaywrightBin(import.meta.url),
    // The worker's notification sweep joins `analysisAttempt -> appUser -> auth.users.email` to
    // find a recipient, so the run's identity is also the mailbox `report-lifecycle.e2e.ts` reads.
    // Unique per run, because Mailpit is shared across concurrent runs and worktrees.
    identityEmail: aTestEmailAddress('system-e2e'),
    playwrightArgs: process.argv.slice(2),
    beforePlaywright: startServices,
  });
}

await main();
