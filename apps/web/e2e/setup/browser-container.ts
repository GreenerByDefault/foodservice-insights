/// <reference types="node" />

/** Lifecycle for the containerized browser every screenshot is captured through.
 *
 * Font rasterization differs between macOS and Linux, and between architectures, so a PNG is only
 * comparable to another PNG taken by the same browser build on the same platform. Rather than keep
 * one snapshot per platform, we pin a single browser: the official Playwright image, always at
 * `linux/arm64`. The app server, the test process, and the developer's laptop are all free to
 * differ — none of them touches a pixel.
 *
 * Only the browser is containerized, not the test run. Nothing from our workspace is mounted or
 * installed into the image, which is why a pnpm workspace of native binaries and compiled `dist/`
 * packages is a non-issue here: none of it is ever visible to the container.
 */

import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The one definition of "correct output" for every committed PNG.
 *
 * **Version lockstep:** `chromium.connect()` refuses a client and server on different Playwright
 * versions, so this must match the `playwright` catalog pin in `pnpm-workspace.yaml`. Bump both
 * in the same commit.
 */
const IMAGE_PLAYWRIGHT_VERSION = '1.62.1';
export const BROWSER_IMAGE = `mcr.microsoft.com/playwright:v${IMAGE_PLAYWRIGHT_VERSION}-noble`;

/** Pinned in the invocation, not inherited from the host, so an x86 Linux developer or a fork
 * contributor gets an emulated arm64 browser — slow, but producing the same pixels — instead of
 * amd64 output and an unexplainable red build.
 *
 * We use ARM64 because most of our developers use Apple Silicon and we want to keep tests
 * fast for them.
 */
const BROWSER_PLATFORM = 'linux/arm64';

const CONTAINER_NAME = 'gbd-web-screenshot-browser';
/** Well outside the ephemeral range, so a stray listener is unlikely to have claimed it. */
const HOST_PORT = 43117;
const SERVER_PORT = 3000;

export const BROWSER_WS_ENDPOINT = `ws://127.0.0.1:${HOST_PORT}/`;

/** Generous, because the first run on a machine pulls a multi-gigabyte image. */
const READY_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 250;

export async function startBrowserServer(): Promise<void> {
  // Cold start (check, maybe stop, run, wait) is serialized so a concurrent run can't tear down
  // the container this one just created — the loser just finds it already serving and returns.
  await withStartupLock(async () => {
    // The container is stateless, so reuse one already serving the pinned image rather than
    // racing a concurrent `screenshots` run to kill and restart it.
    if ((await isRunningCurrentImage()) && (await isServing())) return;

    // Otherwise — absent, unhealthy, or serving a stale image tag — reclaim the name and the port
    // rather than failing on them. This is also the path a run killed mid-flight takes, since that
    // leaves the container behind despite `--rm`.
    await stopBrowserServer();

    await run('docker', [
      'run',
      '--detach',
      '--rm',
      `--name=${CONTAINER_NAME}`,
      `--platform=${BROWSER_PLATFORM}`,
      // Chromium's default 64MB /dev/shm in a container is small enough to crash tabs.
      '--ipc=host',
      // Reaps the zombie processes Chromium leaves behind over a long run.
      '--init',
      '--user=pwuser',
      '--workdir=/home/pwuser',
      // Gives the container one hostname for "the machine running the app server" that resolves
      // on both macOS and Linux, so `baseURL` needs no per-platform branch.
      '--add-host=host.docker.internal:host-gateway',
      // Loopback-only: this socket drives a browser, and nothing outside this machine should.
      `--publish=127.0.0.1:${HOST_PORT}:${SERVER_PORT}`,
      '--entrypoint=/bin/sh',
      BROWSER_IMAGE,
      '-c',
      `npx -y playwright-core@${IMAGE_PLAYWRIGHT_VERSION} run-server ` +
        `--port ${SERVER_PORT} --host 0.0.0.0`,
    ]);

    await waitUntilServing();
  });
}

/** Cross-process mutex for the cold-start critical section, backed by `mkdir`'s atomicity
 * (POSIX guarantees only one caller sees success on a shared path). Files, not sockets or
 * locks scoped to one Node process, because concurrent `screenshots` runs are separate
 * processes.
 */
const LOCK_DIR = join(tmpdir(), `${CONTAINER_NAME}.lock`);
const LOCK_POLL_INTERVAL_MS = 250;
// A cold pull is the slowest thing that can happen inside the lock, so give a waiting run at
// least that long before giving up.
const LOCK_TIMEOUT_MS = READY_TIMEOUT_MS;
// Longer than the timeout above: past this age, the lock is assumed abandoned by a killed
// process rather than held by a slow one.
const LOCK_STALE_MS = LOCK_TIMEOUT_MS + 60_000;

async function withStartupLock<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      await mkdir(LOCK_DIR);
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;

      const lockStat = await stat(LOCK_DIR).catch(() => undefined);
      if (lockStat === undefined) continue; // gone already; retry the mkdir
      if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await rm(LOCK_DIR, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for the browser container startup lock at ${LOCK_DIR}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
    }
  }

  try {
    return await fn();
  } finally {
    await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function stopBrowserServer(): Promise<void> {
  // `docker rm -f` on a name that isn't there is an error, and an uninteresting one.
  await run('docker', ['rm', '--force', CONTAINER_NAME]).catch(() => undefined);
}

/** Drive the browser once, so a broken connection fails here rather than inside a screenshot
 * assertion where it reads as a visual difference.
 */
export async function describeBrowser(): Promise<string> {
  // Imported here rather than at module scope: this module is loaded by playwright.config.ts.
  const { chromium } = await import('playwright');

  const browser = await chromium.connect(BROWSER_WS_ENDPOINT).catch((cause: unknown) => {
    throw new Error(
      `Could not drive the browser server at ${BROWSER_WS_ENDPOINT} (${BROWSER_IMAGE}). ` +
        'The likeliest cause is a Playwright version mismatch: connect() requires the client and ' +
        'the browser server to be the same version, so the image tag above and the `playwright` ' +
        'catalog pin in pnpm-workspace.yaml have to move together.',
      { cause },
    );
  });
  try {
    return `${browser.browserType().name()} ${browser.version()}`;
  } finally {
    await browser.close();
  }
}

async function isRunningCurrentImage(): Promise<boolean> {
  const { stdout } = await run('docker', [
    'inspect',
    '--format={{.State.Running}} {{.Config.Image}}',
    CONTAINER_NAME,
  ]).catch(() => ({ stdout: '' }));
  return stdout.trim() === `true ${BROWSER_IMAGE}`;
}

async function waitUntilServing(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await isServing()) return;

    // The container exiting is the failure worth reporting: an unsupported `--platform`, or a
    // browser server that died on startup. Without this the wait just times out with no cause.
    const { stdout } = await run('docker', [
      'inspect',
      '--format={{.State.Running}}',
      CONTAINER_NAME,
    ]).catch(() => ({ stdout: 'false' }));
    if (stdout.trim() !== 'true') {
      const logs = await run('docker', ['logs', CONTAINER_NAME])
        .then(({ stdout, stderr }) => `${stdout}${stderr}`.trim())
        .catch(() => '(no logs)');
      throw new Error(`The browser container exited before it began serving.\n${logs}`);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `The browser container was not serving on port ${HOST_PORT} within ` +
      `${READY_TIMEOUT_MS / 1000}s.`,
  );
}

/** Whether the browser server itself answers, as opposed to Docker's published port.
 *
 * Docker's published port accepts a TCP connection from the moment the container starts and then
 * resets it, so a connect-only check reports ready while the container is still starting up.
 */
async function isServing(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${HOST_PORT}/`, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}
